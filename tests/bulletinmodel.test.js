#!/usr/bin/env node
/**
 * tests/bulletinmodel.test.js
 *
 * src/BulletinModel.gs 的回歸測試：日期換算、標題預設值、人數表、待填
 * 清單，以及**由真正入口 buildBulletinModel_() 叫下去**的整合案例
 * （用假的 SpreadsheetApp 替身）。
 *
 * 執行方式：node tests/bulletinmodel.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

const GAS_STUBS = {
  Utilities: {
    // 只支援本專案兩個預設樣式就夠——這裡刻意用一個跟 formatDatePatternSimple_
    // 不同的實作，確保「正式路徑真的用了注入進來的 formatDate」測得出來。
    formatDate: function (date, tz, pattern) {
      var y = date.getFullYear();
      var mo = String(date.getMonth() + 1).padStart(2, '0');
      var d = String(date.getDate()).padStart(2, '0');
      if (pattern === 'dd/MM/yyyy') return d + '/' + mo + '/' + y;
      return y + ' 年 ' + mo + ' 月 ' + d + ' 日';
    }
  },
  Session: {
    getScriptTimeZone: function () { return 'Pacific/Auckland'; },
    getActiveUser: function () { return { getEmail: function () { return ''; } }; }
  },
  SpreadsheetApp: {},
  CacheService: {}
};

const sandbox = loadAllSrcFilesInOrder(GAS_STUBS);
const { assembleBulletinModel_, buildMissingList_, formatDatePatternSimple_, addDays_ } = sandbox;

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

function assertArrayEqual(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

const DEFAULT_CONFIG = {
  dateFormatCover: 'yyyy 年 MM 月 dd 日',
  dateFormatInline: 'dd/MM/yyyy',
  defaultPageTitle: '崇拜程序',
  defaultAttendanceHeading: '上週主日崇拜人數',
  defaultNextWeekHeading: '下週主日崇拜聚會事奉肢體',
  defaultPrayerBlockHeading: '代禱事項',
  preludeDefault: '主在聖殿中 (生命聖詩 522)',
  cantoneseSubColumnLabel: '主堂'
};

function assemble(overrides) {
  var o = overrides || {};
  var isoDate = o.isoDate || '2027-10-03';
  return assembleBulletinModel_({
    isoDate: isoDate,
    targetDate: d(isoDate),
    snapshot: o.snapshot || { found: true, weekOfMonth: 1, quarterId: '2027T4', versionNo: 2, isOfficial: false, special: null, isoDate: isoDate },
    nextSnapshot: o.nextSnapshot || null,
    week: o.week || {},
    templateId: o.templateId || 'TPL_NORMAL',
    program: o.program || [],
    dutyBoxPage1: o.dutyBoxPage1 || [],
    nextWeekDuty: o.nextWeekDuty || [],
    announcementRows: o.announcementRows || [],
    prayerRows: o.prayerRows || [],
    fellowshipRows: o.fellowshipRows || [],
    financeRows: o.financeRows || [],
    config: o.config || DEFAULT_CONFIG,
    baptismOptions: o.baptismOptions || {},
    formatDate: o.formatDate || formatDatePatternSimple_,
    warnings: o.warnings || []
  });
}

function missingFields(model) {
  return model.missing.map(function (m) { return m.field; });
}

// =====================================================================
// 日期換算
// =====================================================================

test('attendanceDate 是主日減 7 天、nextWeekDate 是主日加 7 天', function () {
  var model = assemble({ isoDate: '2027-10-03' });
  assert.strictEqual(model.header.attendanceDate, '26/09/2027', '2027-10-03 減 7 天＝2027-09-26');
  assert.strictEqual(model.header.nextWeekDate, '10/10/2027', '2027-10-03 加 7 天＝2027-10-10');
});

test('日期換算跨月也正確', function () {
  var model = assemble({ isoDate: '2027-11-07' });
  assert.strictEqual(model.header.attendanceDate, '31/10/2027');
  assert.strictEqual(model.header.nextWeekDate, '14/11/2027');
});

test('日期換算跨年也正確', function () {
  var model = assemble({ isoDate: '2027-01-02' });
  assert.strictEqual(model.header.attendanceDate, '26/12/2026');
  assert.strictEqual(model.header.nextWeekDate, '09/01/2027');
});

test('coverDate 用 DATE_FORMAT_COVER 格式化', function () {
  var model = assemble({ isoDate: '2027-10-03' });
  assert.strictEqual(model.header.coverDate, '2027 年 10 月 03 日');
});

test('BulletinWeeks 有填 ATTENDANCE_DATE → 以它為準，不用主日減 7 天', function () {
  var model = assemble({ isoDate: '2027-10-03', week: { ATTENDANCE_DATE: d('2027-09-19') } });
  assert.strictEqual(model.header.attendanceDate, '19/09/2027');
});

test('addDays_ 不會修改原本的 Date 物件', function () {
  var original = d('2027-10-03');
  addDays_(original, 7);
  assert.strictEqual(sandbox.formatIsoDate_(original), '2027-10-03');
});

test('formatDatePatternSimple_ 支援 yyyy/yy/MM/M/dd/d', function () {
  var date = d('2027-01-05');
  assert.strictEqual(formatDatePatternSimple_(date, 'yyyy-MM-dd'), '2027-01-05');
  assert.strictEqual(formatDatePatternSimple_(date, 'yy/M/d'), '27/1/5');
});

// =====================================================================
// 標題預設值
// =====================================================================

test('BulletinWeeks 的標題留空 → 用 Config 預設值', function () {
  var model = assemble({ week: {} });
  assert.strictEqual(model.header.pageTitle, '崇拜程序');
  assert.strictEqual(model.header.attendanceHeading, '上週主日崇拜人數');
  assert.strictEqual(model.header.nextWeekHeading, '下週主日崇拜聚會事奉肢體');
  assert.strictEqual(model.prayerBlock.heading, '代禱事項');
});

test('BulletinWeeks 的標題有填 → 以工作表為準', function () {
  var model = assemble({
    week: {
      PAGE_TITLE: '浸禮聯合崇拜程序',
      ATTENDANCE_HEADING: '九月最後主日人數',
      NEXT_WEEK_HEADING: '下週主日浸禮三堂聯合崇拜聚會事奉肢體',
      PRAYER_BLOCK_HEADING: '宣教消息'
    }
  });
  assert.strictEqual(model.header.pageTitle, '浸禮聯合崇拜程序');
  assert.strictEqual(model.header.attendanceHeading, '九月最後主日人數');
  assert.strictEqual(model.header.nextWeekHeading, '下週主日浸禮三堂聯合崇拜聚會事奉肢體');
  assert.strictEqual(model.prayerBlock.heading, '宣教消息');
});

test('標題只有空白字元 → 視為留空，用 Config 預設值', function () {
  var model = assemble({ week: { PAGE_TITLE: '   ' } });
  assert.strictEqual(model.header.pageTitle, '崇拜程序');
});

// =====================================================================
// 人數表
// =====================================================================

test('人數表是 3 列 × 4 欄，全部文字', function () {
  var model = assemble({
    week: {
      ATT_ENG_WORSHIP: '45', ATT_CANE_WORSHIP: '120', ATT_CANN_WORSHIP: '30', ATT_MAN_WORSHIP: '60',
      ATT_ENG_PRAYER: '--', ATT_CANE_PRAYER: '前:5 / 後:120', ATT_CANN_PRAYER: '', ATT_MAN_PRAYER: '8'
    }
  });
  assert.strictEqual(model.attendance.rows.length, 3);
  model.attendance.rows.forEach(function (row) {
    assert.strictEqual(row.values.length, 4);
    row.values.forEach(function (v) { assert.strictEqual(typeof v, 'string'); });
  });
  assertArrayEqual(model.attendance.rows[0].values, ['45', '120', '30', '60']);
  assertArrayEqual(model.attendance.rows[1].values, ['--', '前:5 / 後:120', '', '8'],
    '樣本出現過 -- 與「前:5 / 後:120」，一律當文字原樣保留');
});

test('人數表欄標題用 Config 的 CANTONESE_SUBCOLUMN_LABEL', function () {
  var model = assemble({});
  assertArrayEqual(model.attendance.columns, ['英語堂', '粵語堂主堂', '粵語堂北岸', '華語堂']);
});

// =====================================================================
// 各清單的篩選與排序
// =====================================================================

test('家事報告／代禱／團契／財政：只取該日、ACTIVE=TRUE，按 SEQ_NO 排序', function () {
  var target = d('2027-10-03');
  var other = d('2027-10-10');
  var model = assemble({
    isoDate: '2027-10-03',
    announcementRows: [
      { SERVICE_DATE: target, SEQ_NO: 2, TEXT: '第二則', ACTIVE: true },
      { SERVICE_DATE: target, SEQ_NO: 1, TEXT: '第一則', ACTIVE: true },
      { SERVICE_DATE: target, SEQ_NO: 3, TEXT: '停用的', ACTIVE: false },
      { SERVICE_DATE: other, SEQ_NO: 1, TEXT: '別週的', ACTIVE: true }
    ],
    prayerRows: [{ SERVICE_DATE: target, SEQ_NO: 1, TEXT: '為宣教士禱告', ACTIVE: true }],
    fellowshipRows: [{
      SERVICE_DATE: target, SEQ_NO: 1, FELLOWSHIP_NAME: '安提阿團契',
      MEETING_DATE: '10/5 星期日', MEETING_TIME: '4:30pm', CONTENT: '查經', ACTIVE: true
    }],
    financeRows: [{
      SERVICE_DATE: target, SEQ_NO: 1, ROW_LABEL: '九月奉獻',
      COL_SPECIAL_OVERSEAS: '1,000', COL_HARDSHIP: '500', ACTIVE: true
    }]
  });

  assert.strictEqual(model.announcements.length, 2, '停用與別週的都要濾走');
  assertArrayEqual(model.announcements.map(function (a) { return a.text; }), ['第一則', '第二則']);
  assert.strictEqual(model.prayerBlock.items.length, 1);
  assert.strictEqual(model.fellowships[0].fellowshipName, '安提阿團契');
  assert.strictEqual(model.fellowships[0].meetingDate, '10/5 星期日', '團契日期是文字，原樣保留');
  assert.strictEqual(model.fellowships[0].meetingTime, '4:30pm');
  assert.strictEqual(model.finance[0].specialOverseas, '1,000');
});

// =====================================================================
// 待填清單 missing
// =====================================================================

test('missing：全部留空時，該列的項目都要在（含 12 個人數欄）', function () {
  var model = assemble({ week: {} });
  var fields = missingFields(model);

  assert.ok(fields.indexOf('CALL_TEXT') !== -1, '宣召兩者皆空要算缺');
  ['SCRIPTURE_REF', 'SERMON_TITLE', 'RESPONSE_HYMN', 'FLOWER_THIS_WEEK'].forEach(function (key) {
    assert.ok(fields.indexOf(key) !== -1, key + ' 應該在待填清單內');
  });

  var attCount = fields.filter(function (f) { return f.indexOf('ATT_') === 0; }).length;
  assert.strictEqual(attCount, 12, '12 個人數欄全部留空時應該有 12 項');

  ['ANNOUNCEMENTS', 'PRAYERS', 'FELLOWSHIPS'].forEach(function (key) {
    assert.ok(fields.indexOf(key) !== -1, key + ' 沒有任何有效的行時應該算缺');
  });
});

test('missing：PRELUDE 留空**不**算缺（用 Config PRELUDE_DEFAULT 補上即可）', function () {
  var model = assemble({ week: {} });
  assert.strictEqual(missingFields(model).indexOf('PRELUDE'), -1,
    '68 期樣本序樂全部相同，留空時直接用預設值，不應該每週叫人填一次');
});

test('missing：宣召只要有一項有值就不算缺', function () {
  var onlyRef = assemble({ week: { CALL_REF: '詩篇 100:4' } });
  assert.strictEqual(missingFields(onlyRef).indexOf('CALL_TEXT'), -1, '只有出處是合法的（2026-04-05 樣本）');

  var onlyText = assemble({ week: { CALL_TEXT: '你們要稱謝耶和華' } });
  assert.strictEqual(missingFields(onlyText).indexOf('CALL_TEXT'), -1);
});

test('missing：有內容的欄位不會出現在清單內', function () {
  var model = assemble({
    week: {
      CALL_TEXT: '甲', CALL_REF: '乙', SCRIPTURE_REF: '丙', SERMON_TITLE: '丁',
      RESPONSE_HYMN: '戊', FLOWER_THIS_WEEK: '己',
      ATT_ENG_WORSHIP: '1', ATT_CANE_WORSHIP: '2', ATT_CANN_WORSHIP: '3', ATT_MAN_WORSHIP: '4',
      ATT_ENG_PRAYER: '5', ATT_CANE_PRAYER: '6', ATT_CANN_PRAYER: '7', ATT_MAN_PRAYER: '8',
      ATT_ENG_CHILD: '9', ATT_CANE_CHILD: '10', ATT_CANN_CHILD: '11', ATT_MAN_CHILD: '12'
    },
    announcementRows: [{ SERVICE_DATE: d('2027-10-03'), SEQ_NO: 1, TEXT: 'a', ACTIVE: true }],
    prayerRows: [{ SERVICE_DATE: d('2027-10-03'), SEQ_NO: 1, TEXT: 'p', ACTIVE: true }],
    fellowshipRows: [{ SERVICE_DATE: d('2027-10-03'), SEQ_NO: 1, FELLOWSHIP_NAME: 'f', ACTIVE: true }]
  });
  assert.strictEqual(model.missing.length, 0, '實際剩下：' + JSON.stringify(missingFields(model)));
});

test('missing：state 為 PENDING 的崗位會列入清單', function () {
  var model = assemble({
    week: {},
    dutyBoxPage1: [
      { label: '講員', text: '', postIds: ['PREACHER'], states: ['PENDING'], isPending: true },
      { label: '主席', text: '陳大文', postIds: ['CHAIR'], states: ['ASSIGNED'], isPending: false }
    ]
  });
  var fields = missingFields(model);
  assert.ok(fields.indexOf('POST:PREACHER') !== -1, '未排人的崗位要列入待填');
  assert.strictEqual(fields.indexOf('POST:CHAIR'), -1, '已排人的崗位不算缺');
});

test('missing 每一項都有 field／label／reason 三個欄位', function () {
  var model = assemble({ week: {} });
  assert.ok(model.missing.length > 0);
  model.missing.forEach(function (m) {
    assert.strictEqual(typeof m.field, 'string');
    assert.ok(m.label, 'label 不可以是空的：' + JSON.stringify(m));
    assert.ok(m.reason, 'reason 不可以是空的：' + JSON.stringify(m));
  });
});

test('missing 的 label 用 BulletinWeeks 的中文標題', function () {
  var model = assemble({ week: {} });
  var sermon = model.missing.filter(function (m) { return m.field === 'SERMON_TITLE'; })[0];
  assert.strictEqual(sermon.label, '證道講題');
});

test('buildMissingList_ 可以單獨呼叫', function () {
  var missing = buildMissingList_({
    week: { SCRIPTURE_REF: '有', SERMON_TITLE: '有', RESPONSE_HYMN: '有', FLOWER_THIS_WEEK: '有', CALL_REF: '有' },
    dutyBoxPage1: [],
    announcementCount: 1, prayerCount: 1, fellowshipCount: 1
  });
  var fields = missing.map(function (m) { return m.field; });
  assert.strictEqual(fields.filter(function (f) { return f.indexOf('ATT_') === 0; }).length, 12);
  assert.strictEqual(fields.indexOf('SERMON_TITLE'), -1);
});

// =====================================================================
// 由真正入口 buildBulletinModel_() 叫下去（假 SpreadsheetApp 替身）
// =====================================================================

function ownSheetFor(sheetId, rows) {
  var def = sandbox.COLUMNS[sheetId];
  return makeFakeSheet(def.headers, def.keys, rows || []);
}

function rosterSheetFor(defKey, rows) {
  var keys = Object.keys(sandbox.ROSTER_TABLE_DEFS_[defKey].columns);
  return makeFakeSheet(keys, keys, rows || []);
}

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_BULLETIN_MODEL_TEST';

function configRows(overrides) {
  var base = {};
  sandbox.DEFAULTS.forEach(function (item) { base[item.key] = item.value; });
  base.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  Object.assign(base, overrides || {});
  return Object.keys(base).map(function (key) {
    return { KEY: key, VALUE: base[key], NOTE: '', EDITABLE: true };
  });
}

/**
 * 造一個完整的假環境：own 試算表（Config 與週報自己的各張表）＋ 職事表
 * （openById 開出來）。`rosterDates` 決定職事表有哪幾個主日。
 */
function makeEnvironment(options) {
  var o = options || {};
  var rosterDates = o.rosterDates || ['2027-10-03', '2027-10-10'];

  var serviceDates = rosterDates.map(function (iso, idx) {
    return {
      ServiceDateID: 'SD-' + iso, QuarterID: '2027T4', ServiceDate: iso,
      WeekIndex: idx + 1, IsFirstSundayOfMonth: iso.slice(-2) <= '07',
      ServiceType: '主日崇拜', SpecialID: ''
    };
  });

  var assignments = [];
  rosterDates.forEach(function (iso) {
    assignments.push({
      QuarterID: '2027T4', VersionNo: 2, ServiceDate: iso, PostID: 'CHAIR',
      SlotIndex: 1, PersonID: 'P9001', PersonNameSnapshot: '陳大文',
      AssignSource: 'AUTO', Locked: false
    });
  });

  var ownSheets = {
    Config: ownSheetFor('CONFIG', configRows(o.config)),
    BulletinWeeks: ownSheetFor('BULLETIN_WEEKS', o.bulletinWeeks || []),
    Announcements: ownSheetFor('ANNOUNCEMENTS', o.announcements || []),
    Prayers: ownSheetFor('PRAYERS', o.prayers || []),
    Fellowships: ownSheetFor('FELLOWSHIPS', o.fellowships || []),
    Finance: ownSheetFor('FINANCE', o.finance || []),
    PersonDisplay: ownSheetFor('PERSON_DISPLAY', o.personDisplay || [
      { PERSON_ID: 'P9001', NAME_TC: '陳大文', HONORIFIC: '弟兄', DISPLAY_OVERRIDE: '', EFFECTIVE_FROM: '', EFFECTIVE_TO: '', ACTIVE: true, NOTES: '' }
    ]),
    PostDisplay: ownSheetFor('POST_DISPLAY', sandbox.seedPostDisplayRows_()),
    MergeGroups: ownSheetFor('MERGE_GROUPS', sandbox.seedMergeGroupsRows_()),
    ProgramTemplates: ownSheetFor('PROGRAM_TEMPLATES', sandbox.seedProgramTemplatesRows_()),
    Diagnostics: ownSheetFor('DIAGNOSTICS', []),
    AuditLog: ownSheetFor('AUDIT_LOG', [])
  };

  var rosterSheets = {
    RosterAssignments: rosterSheetFor('ASSIGNMENTS', assignments),
    RosterVersions: rosterSheetFor('VERSIONS', [{ QuarterID: '2027T4', VersionNo: 2 }]),
    Quarters: rosterSheetFor('QUARTERS', [{ QuarterID: '2027T4', Stage: 'DRAFT' }]),
    ServiceDates: rosterSheetFor('SERVICE_DATES', serviceDates),
    SpecialSundays: rosterSheetFor('SPECIAL_SUNDAYS', o.specialSundays || []),
    NameMapping: rosterSheetFor('NAME_MAPPING', [{ PersonID: 'P9001', NameTC: '陳大文', Active: true }]),
    Posts: rosterSheetFor('POSTS', [
      { PostID: 'CHAIR', PostName_TC: '主席', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: true, DisplayOrder: 10, Active: true, EmptyDisplay: 'PENDING' },
      { PostID: 'COMMUNION', PostName_TC: '聖餐襄禮', SlotCount: 4, Frequency: 'FIRST_SUNDAY', AutoGenerate: true, DisplayOrder: 120, Active: true, EmptyDisplay: 'PENDING' }
    ])
  };

  var FakeApp = {
    getActiveSpreadsheet: function () { return makeFakeSpreadsheet(ownSheets); },
    openById: function (id) {
      if (id !== FAKE_ROSTER_ID) throw new Error('openById: 未預期的 id ' + id);
      return makeFakeSpreadsheet(rosterSheets);
    }
  };

  return {
    ownSheets: ownSheets,
    sandbox: loadAllSrcFilesInOrder(Object.assign({}, GAS_STUBS, { SpreadsheetApp: FakeApp }))
  };
}

test('真正入口 buildBulletinModel_()：正常路徑（假 SpreadsheetApp 替身）', function () {
  var env = makeEnvironment({});
  var model = env.sandbox.buildBulletinModel_('2027-10-03');

  assert.strictEqual(model.ok, true);
  assert.strictEqual(model.notConfigured, false);
  assert.strictEqual(model.found, true);
  assert.strictEqual(model.isoDate, '2027-10-03');
  assert.strictEqual(model.weekOfMonth, 1);
  assert.strictEqual(model.quarterId, '2027T4');
  assert.strictEqual(model.rosterVersionUsed, 2);
  assert.strictEqual(model.rosterIsOfficial, false, 'Stage 是 DRAFT');
  assert.strictEqual(model.templateId, 'TPL_NORMAL');

  assert.ok(model.program.length > 0, '程序表應該有內容');
  assert.ok(model.dutyBoxPage1.length > 0, '事奉框應該有內容');

  var chair = model.dutyBoxPage1.filter(function (r) { return r.label === '主席'; })[0];
  assert.ok(chair, '應該有主席那一行');
  assert.strictEqual(chair.text, '陳大文弟兄', '第 1 頁 HONORIFIC_ON_PAGE1=TRUE，要加尊稱');

  assert.strictEqual(model.header.coverDate, '2027 年 10 月 03 日');
  assert.strictEqual(model.header.attendanceDate, '26/09/2027');
  assert.strictEqual(model.header.nextWeekDate, '10/10/2027');
});

test('真正入口：ROSTER_SPREADSHEET_ID 未設定 → notConfigured，不拋錯', function () {
  var env = makeEnvironment({ config: { ROSTER_SPREADSHEET_ID: '' } });
  var model = env.sandbox.buildBulletinModel_('2027-10-03');
  assert.strictEqual(model.notConfigured, true);
  assert.strictEqual(model.ok, false);
});

test('真正入口：首主日有聖餐行、非首主日無聖餐行但有祈禱會行', function () {
  var env = makeEnvironment({});

  var week1 = env.sandbox.buildBulletinModel_('2027-10-03');
  var names1 = week1.program.map(function (r) { return r.itemName; });
  assert.ok(names1.indexOf('聖餐') !== -1, '首主日要有聖餐');
  assert.strictEqual(names1.indexOf('祈禱會'), -1);

  var week2 = env.sandbox.buildBulletinModel_('2027-10-10');
  var names2 = week2.program.map(function (r) { return r.itemName; });
  assert.strictEqual(names2.indexOf('聖餐'), -1, '第 2 個主日沒有聖餐');
  assert.ok(names2.indexOf('祈禱會') !== -1, '第 2 個主日有祈禱會');
});

test('真正入口：非首主日的事奉框沒有「聖餐輔禮」那一行（NOT_APPLICABLE 整行消失）', function () {
  var env = makeEnvironment({});

  var week1 = env.sandbox.buildBulletinModel_('2027-10-03');
  assert.ok(
    week1.dutyBoxPage1.some(function (r) { return r.label === '聖餐輔禮'; }),
    '首主日應該有聖餐輔禮那一行'
  );

  var week2 = env.sandbox.buildBulletinModel_('2027-10-10');
  assert.ok(
    !week2.dutyBoxPage1.some(function (r) { return r.label === '聖餐輔禮'; }),
    '第 2 個主日聖餐輔禮那一行要整行消失'
  );
});

test('真正入口：下一個主日不在職事表 → nextWeekDuty 空陣列＋warning，不拋錯', function () {
  // 職事表只有 2027-10-03 一個主日，所以 2027-10-10 查不到。
  var env = makeEnvironment({ rosterDates: ['2027-10-03'] });
  var model = env.sandbox.buildBulletinModel_('2027-10-03');

  assert.strictEqual(model.ok, true, '不可以因為下週查不到就整個失敗');
  assertArrayEqual(model.nextWeekDuty, []);
  assert.ok(
    model.warnings.some(function (w) { return w.code === 'NEXT_WEEK_NOT_IN_ROSTER'; }),
    '應該有 NEXT_WEEK_NOT_IN_ROSTER 警告，實際：' + JSON.stringify(model.warnings.map(function (w) { return w.code; }))
  );
});

test('真正入口：下一個主日在職事表內 → nextWeekDuty 有內容，且用第 3 頁規則（不加弟兄姊妹）', function () {
  var env = makeEnvironment({});
  var model = env.sandbox.buildBulletinModel_('2027-10-03');

  assert.ok(model.nextWeekDuty.length > 0, '下週事奉應該有內容');
  var chair = model.nextWeekDuty.filter(function (r) { return r.label === '主席'; })[0];
  assert.ok(chair);
  assert.strictEqual(chair.text, '陳大文', '第 3 頁 HONORIFIC_ON_PAGE3=FALSE，不加弟兄姊妹');
});

test('真正入口：BulletinWeeks 沒有該行 → 記警告，其餘欄位當空白，不拋錯', function () {
  var env = makeEnvironment({ bulletinWeeks: [] });
  var model = env.sandbox.buildBulletinModel_('2027-10-03');
  assert.strictEqual(model.ok, true);
  assert.ok(model.warnings.some(function (w) { return w.code === 'BULLETIN_WEEK_ROW_NOT_FOUND'; }));
  assert.strictEqual(model.header.pageTitle, '崇拜程序', '留空時用 Config 預設值');
});

test('真正入口：特別主日按日期比對得到 → 範本推斷成 TPL_COMBINED_BAPTISM 並寫回 BulletinWeeks', function () {
  var env = makeEnvironment({
    specialSundays: [{
      SpecialID: 'SP1', QuarterID: '2027T4', ServiceDate: '2027-10-03',
      Type: 'BAPTISM', Title: '十月主日（浸禮）', SkipPostIDs: '', LockPostIDs: '',
      ExternalOwner: '', CommunionOverride: '', TranslationRequired: false, Active: true
    }],
    bulletinWeeks: [{
      SERVICE_DATE: '2027-10-03', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1,
      PROGRAM_TEMPLATE_ID: '', STATUS: 'DRAFT'
    }]
  });

  var model = env.sandbox.buildBulletinModel_('2027-10-03');
  assert.ok(model.special, '應該按日期查到特別主日（SpecialID 在 ServiceDates 是空的）');
  assert.strictEqual(model.special.title, '十月主日（浸禮）');
  assert.strictEqual(model.templateId, 'TPL_COMBINED_BAPTISM');

  assert.ok(
    !model.warnings.some(function (w) { return w.code === 'TEMPLATE_WRITEBACK_FAILED'; }),
    '寫回不應該失敗，實際警告：' + JSON.stringify(model.warnings.map(function (w) { return w.code; }))
  );

  // 寫回工作表：重新讀一次 BulletinWeeks，PROGRAM_TEMPLATE_ID 應該已經有值。
  var weekRows = env.sandbox.readSheet('BulletinWeeks');
  assert.strictEqual(weekRows[0].PROGRAM_TEMPLATE_ID, 'TPL_COMBINED_BAPTISM', '推斷結果要寫回工作表');

  var auditRows = env.sandbox.readSheet('AuditLog');
  assert.ok(
    auditRows.some(function (r) { return r.ACTION === 'INFER_PROGRAM_TEMPLATE'; }),
    '寫回時要記一筆 AuditLog'
  );
});

test('真正入口：BulletinWeeks 已指定範本 → 不覆蓋、不記 AuditLog', function () {
  var env = makeEnvironment({
    specialSundays: [{
      SpecialID: 'SP1', QuarterID: '2027T4', ServiceDate: '2027-10-03',
      Type: 'BAPTISM', Title: '十月主日（浸禮）', SkipPostIDs: '', LockPostIDs: '',
      ExternalOwner: '', CommunionOverride: '', TranslationRequired: false, Active: true
    }],
    bulletinWeeks: [{
      SERVICE_DATE: '2027-10-03', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1,
      PROGRAM_TEMPLATE_ID: 'TPL_NORMAL', STATUS: 'DRAFT'
    }]
  });

  var model = env.sandbox.buildBulletinModel_('2027-10-03');
  assert.strictEqual(model.templateId, 'TPL_NORMAL', '人手指定優先');
  var auditRows = env.sandbox.readSheet('AuditLog');
  assert.ok(!auditRows.some(function (r) { return r.ACTION === 'INFER_PROGRAM_TEMPLATE'; }));
});

test('真正入口：isoDate 格式不對 → 拋錯', function () {
  var env = makeEnvironment({});
  assert.throws(function () { env.sandbox.buildBulletinModel_('2027/10/03'); });
});

// =====================================================================
// 浸禮副框（合併版 prompt 第 1 部分）
// =====================================================================

test('浸禮：isBaptismSunday 由 templateId 決定（只有 TPL_COMBINED_BAPTISM 為 true）', function () {
  assert.strictEqual(assemble({ templateId: 'TPL_COMBINED_BAPTISM' }).isBaptismSunday, true);
  assert.strictEqual(assemble({ templateId: 'TPL_NORMAL' }).isBaptismSunday, false);
  assert.strictEqual(assemble({ templateId: 'TPL_ANNIVERSARY' }).isBaptismSunday, false);
});

test('浸禮：model.baptism 六個鍵一定齊全，即使不是浸禮主日（隱藏不等於刪除）', function () {
  var model = assemble({
    templateId: 'TPL_NORMAL',
    week: { BAPTISM_MEMBERS: '乙 丙' }
  });
  assertArrayEqual(Object.keys(model.baptism).sort(), sandbox.baptismBoxFieldKeys_().slice().sort());
  assert.strictEqual(model.baptism.BAPTISM_MEMBERS, '乙 丙',
    '不是浸禮主日一樣要把已填的值帶出來——版面上出不出現由渲染層決定，不是靠模型清空');
});

test('浸禮：單人欄位套尊稱、多人欄位原樣（由 baptismOptions 帶 PersonDisplay 進來）', function () {
  var model = assemble({
    templateId: 'TPL_COMBINED_BAPTISM',
    week: { BAPTISM_OFFICIANT: '甲', BAPTISM_MEMBERS: '甲 乙' },
    baptismOptions: {
      withHonorific: true,
      personDisplayRows: [
        { PERSON_ID: 'P1', NAME_TC: '甲', HONORIFIC: '牧師', DISPLAY_OVERRIDE: '', EFFECTIVE_FROM: '', EFFECTIVE_TO: '', ACTIVE: true, NOTES: '' }
      ],
      targetDate: null
    }
  });
  assert.strictEqual(model.baptism.BAPTISM_OFFICIANT, '甲牧師');
  assert.strictEqual(model.baptism.BAPTISM_MEMBERS, '甲 乙', '多人欄位原樣，不加尊稱');
});

test('浸禮：單人欄位查不到姓名 → warning 進得到 model.warnings（不是進呼叫方那個原始陣列）', function () {
  var model = assemble({
    templateId: 'TPL_COMBINED_BAPTISM',
    week: { BAPTISM_OFFICIANT: '查無此人' },
    baptismOptions: { withHonorific: true, personDisplayRows: [], targetDate: null }
  });
  var hit = model.warnings.filter(function (w) { return w.code === 'OVERRIDE_NAME_NOT_IN_PERSON_DISPLAY'; });
  assert.strictEqual(hit.length, 1, 'warning 一定要出現在模型帶出去的那一份，否則靜靜不見：'
    + JSON.stringify(model.warnings));
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
