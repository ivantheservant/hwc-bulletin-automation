#!/usr/bin/env node
/**
 * tests/combinedattendance.test.js
 *
 * 2026-11-02（Ivan）：合堂主日之後那一期的人數表——印刷版（2025-10、2026-09-06、2026-10-11）不印四堂十二格，
 * 只印一欄「合堂」（崇拜／祈禱會／兒童三格）。
 *   - 內容表「崇拜人數」加合堂三欄（ATT_COMB_WORSHIP／ATT_COMB_PRAYER／ATT_COMB_CHILD，「有效」之前），匯入規則與十二格相同；
 *   - 2026-11-03：未有合堂三欄的舊分頁照常匯入（只提示），「更新本季內容表…」重新整理加上三欄（舊分頁改名保留）；
 *     日子橫放另見 tests/transposed.test.js；
 *   - Word：十二格那一張表每一列 {{#IF:ATTENDANCE_NORMAL_SHOW}}、一欄那一張每一列 {{#IF:ATTENDANCE_COMBINED_SHOW}}；
 *   - 待填：只列會印的那一組；全部空白而上週是合堂崇拜就講填合堂三格（填寫介面、本季待填清單、寄出前檢查同一句）。
 *
 * 真正入口：generateBulletinDocx_、buildPreviewPage_、apiRunQuarterContentImport、apiPreviewContentSheetBuild、
 * apiRunContentSheetBuild、apiLoadWeek、apiSaveWeek、quarterMissingFieldsReport_、buildPublishPrecheck_。
 *
 * 執行方式：node tests/combinedattendance.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contentEnv = require('./helpers/contentEnv');
const { makeWordEnv } = require('./helpers/wordEnv');
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
function plain(v) { return JSON.parse(JSON.stringify(v)); }

const COMBINED_TEXT = '格未填（上週是合堂崇拜：請在內容表「崇拜人數」那一行填合堂三格，其餘留空）';

console.log('\n純函式：版面判斷、人數表、待填');

test('CA-1 hasCombinedAttendance_／buildAttendanceTable_：合堂三格任何一格有字＝一欄（標題跟 Config）；否則四堂十二格', function () {
  const sb = makeWordEnv({}).sandbox;
  const week = { ATT_COMB_WORSHIP: '285', ATT_COMB_PRAYER: '6', ATT_COMB_CHILD: '28', ATT_ENG_WORSHIP: '' };
  assert.strictEqual(sb.hasCombinedAttendance_(week), true);
  assert.strictEqual(sb.hasCombinedAttendance_({ ATT_COMB_PRAYER: '  --  ' }), true, '「--」亦算有字');
  assert.strictEqual(sb.hasCombinedAttendance_({ ATT_COMB_WORSHIP: '   ', ATT_ENG_WORSHIP: '50' }), false);
  assert.strictEqual(sb.hasCombinedAttendance_(null), false);
  const t = plain(sb.buildAttendanceTable_(week, '主堂', '三堂聯合'));
  assert.deepStrictEqual(t, {
    columns: ['三堂聯合'], combined: true, combinedLabel: '三堂聯合',
    rows: [{ label: '崇拜', values: ['285'] }, { label: '祈禱會', values: ['6'] }, { label: '兒童', values: ['28'] }]
  });
  assert.deepStrictEqual(plain(sb.buildAttendanceTable_(week, '主堂', '')).columns, ['合堂'], 'Config 空白用預設「合堂」');
  const normal = plain(sb.buildAttendanceTable_({ ATT_ENG_WORSHIP: '54', ATT_MAN_CHILD: '4' }, '主堂', '合堂'));
  assert.strictEqual(normal.combined, false);
  assert.deepStrictEqual(normal.columns, ['英語堂', '粵語堂主堂', '粵語堂北岸', '華語堂']);
  assert.deepStrictEqual(normal.rows[0].values, ['54', '', '', '']);
});

test('CA-2 buildRenderContext_：合堂版面 → ATTENDANCE_COMBINED_SHOW 有、ATTENDANCE_NORMAL_SHOW 空；平常版面相反；三格與標題照填', function () {
  const sb = makeWordEnv({}).sandbox;
  const combined = sb.buildRenderContext_({
    weekFields: { ATT_COMB_WORSHIP: '231', ATT_COMB_PRAYER: '--', ATT_COMB_CHILD: '32' },
    attendance: { combined: true, combinedLabel: '三堂聯合' }
  }, {}).values;
  assert.strictEqual(combined.ATTENDANCE_COMBINED_SHOW, '有');
  assert.strictEqual(combined.ATTENDANCE_NORMAL_SHOW, '');
  assert.strictEqual(combined.ATT_COMB_WORSHIP, '231');
  assert.strictEqual(combined.ATT_COMB_PRAYER, '--');
  assert.strictEqual(combined.ATT_COMB_CHILD, '32');
  assert.strictEqual(combined.ATTENDANCE_COMBINED_LABEL, '三堂聯合', '標題跟資料模型（Config）');
  const normal = sb.buildRenderContext_({ weekFields: { ATT_ENG_WORSHIP: '54' } }, { attendanceCombinedLabel: '聯合' }).values;
  assert.strictEqual(normal.ATTENDANCE_COMBINED_SHOW, '');
  assert.strictEqual(normal.ATTENDANCE_NORMAL_SHOW, '有');
  assert.strictEqual(normal.ATTENDANCE_COMBINED_LABEL, '聯合', '手砌的模型沒有 attendance.combinedLabel 才用 options');
  assert.ok(sb.supportedValuePlaceholderNames_().indexOf('ATTENDANCE_COMBINED_SHOW') !== -1, '檢查範本佔位符要認得新佔位符');
});

test('CA-3 buildMissingList_：只列會印的那一組；全部空白看上週是不是合堂崇拜；合併成一行的字眼講明填合堂三格', function () {
  const sb = makeWordEnv({}).sandbox;
  function attFields(input) {
    return plain(sb.buildMissingList_(Object.assign({ announcementCount: 1, prayerCount: 1, fellowshipCount: 1 }, input)))
      .filter(function (m) { return sb.isAttendanceMissingItem_(m); });
  }
  // 合堂三格只填了兩格：只列那一格，十二格一格都不列。
  const a = attFields({ week: { ATT_COMB_WORSHIP: '285', ATT_COMB_CHILD: '28' } });
  assert.deepStrictEqual(a.map(function (m) { return m.field; }), ['ATT_COMB_PRAYER']);
  assert.strictEqual(a[0].reason, '合堂人數尚未填寫。');
  assert.strictEqual(a[0].label, '合堂祈禱會');
  // 十二格填了一部分：只列十二格的空格，合堂三格不列（即使上週是合堂崇拜——填了哪一組就印哪一組）。
  const b = attFields({ week: { ATT_ENG_WORSHIP: '54' }, attendanceCombinedService: true });
  assert.strictEqual(b.length, 11);
  assert.ok(b.every(function (m) { return !sb.isCombinedAttendanceMissingItem_(m); }));
  // 十五格全部空白：上週是合堂崇拜 → 合堂三格；不是 → 十二格。
  const c = attFields({ week: {}, attendanceCombinedService: true });
  assert.deepStrictEqual(c.map(function (m) { return m.field; }), ['ATT_COMB_WORSHIP', 'ATT_COMB_PRAYER', 'ATT_COMB_CHILD']);
  assert.strictEqual(attFields({ week: {} }).length, 12, '沒有傳旗標＝平常，與以前一樣十二格');
  // 合併成一行（填寫介面面板）。
  const merged = plain(sb.mergeAttendanceMissingItems_(sb.buildMissingList_({ week: {}, attendanceCombinedService: true,
    announcementCount: 1, prayerCount: 1, fellowshipCount: 1 })));
  const att = merged.filter(function (m) { return m.field === 'ATT_*'; });
  assert.strictEqual(att.length, 1);
  assert.strictEqual(att[0].reason, '3 ' + COMBINED_TEXT);
  assert.strictEqual(att[0].cellCount, 3);
  assert.strictEqual(sb.attendanceMissingSummaryText_(12), '12 格未填（上週崇拜人數由內容表輸入）', '平常的字眼不變');
  assertWrittenChinese(assert, '待填字眼', [sb.attendanceMissingSummaryText_(3, true), a[0].reason]);
});

test('CA-4 isCombinedServiceWeekResolved_：職事表合堂、人手選的合堂範本、標題推斷到合堂範本都算；平常範本不算', function () {
  const sb = makeWordEnv({}).sandbox;
  const cfg = { baptismKeywords: ['浸禮'], anniversaryKeywords: ['堂慶'], combinedKeywords: ['合堂'], templateDefault: 'TPL_NORMAL',
    combinedKindTemplates: { MISSION: 'TPL_MISSION' } };
  assert.strictEqual(sb.isCombinedServiceWeekResolved_({}, { combined: { kind: 'COMBINED', name: '' } }, cfg), true);
  assert.strictEqual(sb.isCombinedServiceWeekResolved_({ PROGRAM_TEMPLATE_ID: 'TPL_COMBINED' }, null, cfg), true);
  assert.strictEqual(sb.isCombinedServiceWeekResolved_({ PROGRAM_TEMPLATE_ID: 'TPL_MISSION' }, null, cfg), true, 'Config 種類對應的範本亦算');
  assert.strictEqual(sb.isCombinedServiceWeekResolved_({}, { special: { title: '第60屆浸禮主日' } }, cfg), true);
  assert.strictEqual(sb.isCombinedServiceWeekResolved_({}, { special: { title: '堂慶' } }, cfg), true);
  assert.strictEqual(sb.isCombinedServiceWeekResolved_({}, null, cfg), false);
  assert.strictEqual(sb.isCombinedServiceWeekResolved_({ PROGRAM_TEMPLATE_ID: 'TPL_NORMAL' }, { special: { title: '浸禮' } }, cfg), false,
    '人手選了平常範本就不是合堂');
});

test('CA-5 transposedKeyPrefixLength_：只有「真前段＋其餘空白」才算少了行', function () {
  const sb = makeWordEnv({}).sandbox;
  const keys = ['SERVICE_DATE', 'A', 'B', 'C'];
  assert.strictEqual(sb.transposedKeyPrefixLength_(['SERVICE_DATE', 'A', '', ''], keys), 2);
  assert.strictEqual(sb.transposedKeyPrefixLength_(['SERVICE_DATE', 'A', 'B', 'C'], keys), 0, '齊全不算少');
  assert.strictEqual(sb.transposedKeyPrefixLength_(['', '', '', ''], keys), 0);
  assert.strictEqual(sb.transposedKeyPrefixLength_(['SERVICE_DATE', 'A', '', 'C'], keys), 0, '中間空了一格＝位置不明');
  assert.strictEqual(sb.transposedKeyPrefixLength_(['SERVICE_DATE', 'X', '', ''], keys), 0);
});

// =====================================================================
// Word（真入口 generateBulletinDocx_）
// =====================================================================

console.log('\nWord（真入口 generateBulletinDocx_）');

const D = '2027-11-07';
const D_NEXT = '2027-11-14';

function documentXmlOf(blob) {
  const hit = blob.__entries.filter(function (e) { return e.getName() === 'word/document.xml'; });
  assert.strictEqual(hit.length, 1);
  return hit[0].__text;
}
function visibleText(xml) {
  const out = [];
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = pattern.exec(xml)) !== null) out.push(m[1]);
  return out.join('|');
}

/** 範本的人數部分（docs/佔位符對照表.md「合堂主日之後那一期」的寫法）：標題段落、十二格表、一欄表。 */
function attendanceTemplate() {
  const c = function (t) { return fx.cell(fx.para(fx.run(t))); };
  const N = '{{#IF:ATTENDANCE_NORMAL_SHOW}}';
  const C = '{{#IF:ATTENDANCE_COMBINED_SHOW}}';
  return buildFakeDocx(fx.documentXml(
    fx.para(fx.run('{{ATTENDANCE_HEADING}}（{{ATTENDANCE_DATE}}）'))
    + fx.table([
      fx.row([c(N), c('英語堂'), c('粵語堂{{CANTONESE_SUBCOLUMN_LABEL}}'), c('粵語堂北岸'), c('華語堂')]),
      fx.row([c(N + '崇拜'), c('{{ATT_ENG_WORSHIP}}'), c('{{ATT_CANE_WORSHIP}}'), c('{{ATT_CANN_WORSHIP}}'), c('{{ATT_MAN_WORSHIP}}')]),
      fx.row([c(N + '崇拜前/後祈禱會'), c('{{ATT_ENG_PRAYER}}'), c('{{ATT_CANE_PRAYER}}'), c('{{ATT_CANN_PRAYER}}'), c('{{ATT_MAN_PRAYER}}')]),
      fx.row([c(N + '兒童崇拜/主日學'), c('{{ATT_ENG_CHILD}}'), c('{{ATT_CANE_CHILD}}'), c('{{ATT_CANN_CHILD}}'), c('{{ATT_MAN_CHILD}}')])
    ])
    + fx.table([
      fx.row([c(C), c('{{ATTENDANCE_COMBINED_LABEL}}')]),
      fx.row([c(C + '崇拜'), c('{{ATT_COMB_WORSHIP}}')]),
      fx.row([c(C + '崇拜前/後祈禱會'), c('{{ATT_COMB_PRAYER}}')]),
      fx.row([c(C + '兒童崇拜/主日學'), c('{{ATT_COMB_CHILD}}')])
    ])
  ));
}
function wordEnvWithAttendance(week, config) {
  return makeWordEnv({
    config: config || {},
    driveOptions: { files: { FAKE_TEMPLATE_ID_NORMAL: attendanceTemplate() } },
    weekRows: [
      Object.assign({ SERVICE_DATE: D, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT', SERMON_TITLE: '講題一' }, week),
      { SERVICE_DATE: D_NEXT, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 2, STATUS: 'DRAFT', SERMON_TITLE: '講題二' }
    ]
  });
}

test('CA-6 合堂三格有字（2026-10-11 真實資料 285／6／28）：只印一欄「合堂」那一張表，十二格那一張整張拿走；標題照 ATTENDANCE_HEADING', function () {
  const env = wordEnvWithAttendance({ ATTENDANCE_HEADING: '上週浸禮主日合堂崇拜人數',
    ATT_COMB_WORSHIP: '285', ATT_COMB_PRAYER: '6', ATT_COMB_CHILD: '28' });
  const r = env.sandbox.generateBulletinDocx_(D);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const xml = documentXmlOf(r.blob);
  const text = visibleText(xml);
  assert.strictEqual((xml.match(/<w:tbl>/g) || []).length, 1, '只剩一張人數表\n' + text);
  // 日期由假 Utilities.formatDate 產生（固定字串），這裏只核對標題。
  ['上週浸禮主日合堂崇拜人數（', '|合堂|', '崇拜|285', '崇拜前/後祈禱會|6', '兒童崇拜/主日學|28'].forEach(function (p) {
    assert.ok(text.indexOf(p) !== -1, '缺少：' + p + '\n' + text);
  });
  ['英語堂', '華語堂'].forEach(function (p) { assert.strictEqual(text.indexOf(p), -1, '十二格那一張不可以印：' + text); });
  assert.ok(xml.indexOf('{{') === -1, '不可以殘留佔位符');
  assert.strictEqual(r.residual.count, 0);
});

test('CA-7 沒有合堂三格（平常一期）：只印十二格那一張，一欄那一張整張拿走；Config 改欄標題亦不影響平常版面', function () {
  const env = wordEnvWithAttendance({ ATT_ENG_WORSHIP: '54', ATT_CANE_WORSHIP: '160', ATT_CANN_WORSHIP: '25', ATT_MAN_WORSHIP: '35',
    ATT_ENG_PRAYER: '38', ATT_CANE_PRAYER: '前:5 / 後:110', ATT_CANN_PRAYER: '5', ATT_MAN_PRAYER: '9',
    ATT_ENG_CHILD: '25', ATT_CANE_CHILD: '--', ATT_CANN_CHILD: '6', ATT_MAN_CHILD: '4' }, { ATTENDANCE_COMBINED_COLUMN_LABEL: '三堂聯合' });
  const r = env.sandbox.generateBulletinDocx_(D);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const xml = documentXmlOf(r.blob);
  const text = visibleText(xml);
  assert.strictEqual((xml.match(/<w:tbl>/g) || []).length, 1, '只剩一張人數表\n' + text);
  ['上週主日崇拜人數（', '英語堂|粵語堂主堂|粵語堂北岸|華語堂', '崇拜|54|160|25|35', '崇拜前/後祈禱會|38|前:5 / 後:110|5|9',
    '兒童崇拜/主日學|25|--|6|4'].forEach(function (p) {
    assert.ok(text.indexOf(p) !== -1, '缺少：' + p + '\n' + text);
  });
  ['三堂聯合', '合堂'].forEach(function (p) { assert.strictEqual(text.indexOf(p), -1, '一欄那一張不可以印：' + text); });
  assert.ok(xml.indexOf('{{') === -1, '不可以殘留佔位符');
});

test('CA-8 Config ATTENDANCE_COMBINED_COLUMN_LABEL＝「三堂聯合」（2025-10 的寫法）→ 合堂那一欄的標題跟 Config；草稿預覽頁同一欄', function () {
  const env = wordEnvWithAttendance({ ATT_COMB_WORSHIP: '231', ATT_COMB_PRAYER: '--', ATT_COMB_CHILD: '32' },
    { ATTENDANCE_COMBINED_COLUMN_LABEL: '三堂聯合' });
  const r = env.sandbox.generateBulletinDocx_(D);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const text = visibleText(documentXmlOf(r.blob));
  ['|三堂聯合|', '崇拜|231', '崇拜前/後祈禱會|--', '兒童崇拜/主日學|32'].forEach(function (p) {
    assert.ok(text.indexOf(p) !== -1, '缺少：' + p + '\n' + text);
  });
  const page = env.sandbox.buildPreviewPage_(D);
  assert.strictEqual(page.ok, true, JSON.stringify(page).slice(0, 300));
  const html = String(page.html);
  assert.ok(html.indexOf('<th>三堂聯合</th>') !== -1, '預覽頁人數表只有一欄「三堂聯合」');
  assert.strictEqual(html.indexOf('<th>英語堂</th>'), -1);
});

// =====================================================================
// 待填（真入口：填寫介面、本季待填清單、寄出前檢查）
// =====================================================================

console.log('\n待填（真入口）');

const FILL_DATES = ['2027-11-07', '2027-11-14', '2027-11-21', '2027-11-28'];
function missingEnv(extraRows, combinedServices) {
  return makeWordEnv({
    combinedServices: combinedServices || {},
    weekRows: FILL_DATES.map(function (iso, i) {
      return Object.assign({ SERVICE_DATE: iso, QUARTER_ID: '2027T4', WEEK_OF_MONTH: i + 1, STATUS: 'DRAFT', SERMON_TITLE: '講題' },
        (extraRows || {})[iso] || {});
    })
  });
}

test('CA-9 上週（11-07）職事表設為浸禮合堂、人數全部空白 → 11-14 三處都講「3 格未填（上週是合堂崇拜…）」，字眼一字不差；11-07 本身照舊 12 格', function () {
  const env = missingEnv({}, { '2027-11-07': { kind: 'BAPTISM', name: '第60屆浸禮主日' } });
  const sb = env.sandbox;
  const report = sb.quarterMissingFieldsReport_('2027T4');
  assert.strictEqual(report.ok, true, report.message);
  const lines = Array.from(report.lines);
  assert.ok(lines.indexOf('2027-11-14　人數：3 ' + COMBINED_TEXT) !== -1, lines.join('\n'));
  assert.ok(lines.indexOf('2027-11-07　人數：12 格未填（上週崇拜人數由內容表輸入）') !== -1, lines.join('\n'));
  const precheck = Array.from(sb.buildPublishPrecheck_('2027-11-14', false).lines);
  assert.ok(precheck.indexOf('　人數：3 ' + COMBINED_TEXT) !== -1, precheck.join('\n'));
  const load = sb.apiLoadWeek('2027-11-14');
  assert.strictEqual(load.ok, true, JSON.stringify(load.error));
  const panel = plain(load.data.missingSplit.panel.required).filter(function (m) { return m.label === '人數'; });
  assert.deepStrictEqual(panel.map(function (m) { return m.reason; }), ['3 ' + COMBINED_TEXT]);
  assertWrittenChinese(assert, '本季待填清單', lines);
});

test('CA-10 上週人手選了合堂範本（PROGRAM_TEMPLATE_ID＝TPL_COMBINED）→ 一樣講合堂三格；合堂三格填了就不再列十二格', function () {
  const env = missingEnv({
    '2027-11-21': { PROGRAM_TEMPLATE_ID: 'TPL_COMBINED' },
    '2027-11-14': { ATT_COMB_WORSHIP: '285', ATT_COMB_PRAYER: '6', ATT_COMB_CHILD: '28' }
  });
  const sb = env.sandbox;
  const lines = Array.from(sb.quarterMissingFieldsReport_('2027T4').lines);
  assert.ok(lines.indexOf('2027-11-28　人數：3 ' + COMBINED_TEXT) !== -1, lines.join('\n'));
  assert.strictEqual(lines.filter(function (l) { return l.indexOf('2027-11-14　人數') === 0; }).length, 0,
    '合堂三格齊全 → 人數沒有待填（十二格不列）：' + lines.join('\n'));
  const model = sb.buildBulletinModel_('2027-11-14');
  assert.strictEqual(model.attendance.combined, true);
  assert.deepStrictEqual(plain(model.attendance.columns), ['合堂']);
});

test('CA-11 apiLoadWeek：合堂三格送去前端（唯讀）、readOnly.attendanceCombined；填寫介面有合堂那張表；儲存送合堂三格被拒', function () {
  const env = missingEnv({ '2027-11-14': { ATT_COMB_WORSHIP: '285', ATT_COMB_PRAYER: '6', ATT_COMB_CHILD: '28' } });
  const load = env.sandbox.apiLoadWeek('2027-11-14');
  assert.strictEqual(load.ok, true, JSON.stringify(load.error));
  assert.strictEqual(String(load.data.week.ATT_COMB_WORSHIP), '285');
  assert.strictEqual(load.data.readOnly.attendanceCombined, true);
  ['ATT_COMB_WORSHIP', 'ATT_COMB_PRAYER', 'ATT_COMB_CHILD'].forEach(function (k) {
    assert.ok(load.data.readOnly.readOnlyFields.week.indexOf(k) !== -1, k + ' 唯讀');
  });
  assert.strictEqual(load.data.options.attendanceCombinedLabel, '合堂');
  assert.strictEqual(env.sandbox.apiLoadWeek('2027-11-21').data.readOnly.attendanceCombined, false);
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Index.html'), 'utf8');
  ['data-field="ATT_COMB_WORSHIP"', 'data-field="ATT_COMB_PRAYER"', 'data-field="ATT_COMB_CHILD"', 'id="attCombinedTable"'].forEach(function (p) {
    assert.ok(html.indexOf(p) !== -1, 'Index.html 缺少 ' + p);
  });
  const save = env.sandbox.apiSaveWeek({ isoDate: '2027-11-14', lastSavedAt: load.data.lastSavedAt, payloadVersion: 2,
    baseWeek: { ATT_COMB_WORSHIP: '285' }, week: { ATT_COMB_WORSHIP: '300' } });
  assert.strictEqual(save.ok, false, JSON.stringify(save));
  assert.strictEqual(save.error.code, 'CONTENT_SHEET_READONLY');
  assert.ok(save.error.message.indexOf('合堂崇拜人數（ATT_COMB_WORSHIP）') !== -1, save.error.message);
  assert.strictEqual(String(env.sandbox.readSheet_('BulletinWeeks')[1].ATT_COMB_WORSHIP), '285');
});

// =====================================================================
// 內容表（真入口）
// =====================================================================

console.log('\n內容表：匯入、更新（真入口）');

const QUARTER_ID = contentEnv.QUARTER_ID;
const DATES = contentEnv.SERVICE_DATES;
function minus7(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}
function weekOf(env, iso) {
  return env.sandbox.readSheet_('BulletinWeeks').filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === iso; })[0];
}
/** 每一期一欄（崇拜日期＝那一期減七天）；第 2 期（DATES[1]）十二格留空。 */
function attRows(extra) {
  return DATES.map(function (iso, i) {
    return Object.assign({ SERVICE_DATE: minus7(iso), ATT_ENG_WORSHIP: i === 1 ? '' : String(50 + i) }, (extra || {})[i] || {});
  });
}
/** 一個崇拜日期一行（2026-11-03 起現行）：那一日那一欄的值。 */
function cellOf(sheet, key, iso) {
  const c = sheet.__data[1].indexOf(key);
  const r = sheet.__data.findIndex(function (row, i) { return i >= 2 && row[0] === iso; });
  return r === -1 || c === -1 ? undefined : sheet.__data[r][c];
}
function setCell(sheet, key, iso, value) {
  const c = sheet.__data[1].indexOf(key);
  const r = sheet.__data.findIndex(function (row, i) { return i >= 2 && row[0] === iso; });
  sheet.__data[r][c] = value;
}
function snapshot(env) {
  return JSON.stringify(env.contentSpreadsheet.getSheets().map(function (s) {
    return { name: s.getName(), hidden: s.isSheetHidden(), data: s.__data };
  }));
}
function attDef(env) {
  return env.sandbox.contentSheetTabDefs_().filter(function (d) { return d.tabName === '崇拜人數'; })[0];
}

test('CA-12 apiRunQuarterContentImport：合堂三格（崇拜日期那一行）匯入「加七天」那一期，與十二格同一個規則；清空亦跟內容表', function () {
  // DATES[1] 那一期印的是崇拜日期 minus7(DATES[1])＝DATES[0] 那一日：合堂，只填合堂三格。
  const env = contentEnv.makeEnv({
    content: { 崇拜人數: attRows({ 1: { ATT_COMB_WORSHIP: '285', ATT_COMB_PRAYER: '6', ATT_COMB_CHILD: '28' } }) }
  });
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, true, JSON.stringify(imp.data));
  const w1 = weekOf(env, DATES[1]);
  assert.strictEqual(String(w1.ATT_COMB_WORSHIP), '285');
  assert.strictEqual(String(w1.ATT_COMB_PRAYER), '6');
  assert.strictEqual(String(w1.ATT_COMB_CHILD), '28');
  assert.strictEqual(String(w1.ATT_ENG_WORSHIP || ''), '');
  assert.strictEqual(String(weekOf(env, DATES[0]).ATT_ENG_WORSHIP), '50');
  assert.strictEqual(String(weekOf(env, DATES[0]).ATT_COMB_WORSHIP || ''), '');
  const model = env.sandbox.buildBulletinModel_(DATES[1]);
  assert.strictEqual(model.attendance.combined, true);
  assert.strictEqual(model.missing.filter(function (m) { return env.sandbox.isAttendanceMissingItem_(m); }).length, 0);
  // 內容表之後把一格清空（例如填錯）：匯入照樣清空週報那一格（與十二格一樣以內容表為準）。
  setCell(env.contentTabs['崇拜人數'], 'ATT_COMB_WORSHIP', DATES[0], '');
  assert.strictEqual(env.sandbox.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  assert.strictEqual(String(weekOf(env, DATES[1]).ATT_COMB_WORSHIP || ''), '');
  assert.strictEqual(String(weekOf(env, DATES[1]).ATT_COMB_PRAYER), '6');
});

const ROWS_NOTICE = '內容表「崇拜人數」未有合堂三欄（合堂崇拜、合堂祈禱會、合堂兒童），請按「更新本季內容表…」補上；'
  + '未補之前其餘人數照常匯入，合堂三格不會匯入。';

test('CA-13 2026-10-30 之前的一個日期一行（未有合堂三欄）：apiRunQuarterContentImport 照常匯入十二格，合堂三格不碰（週報已有的值保留），結果講明要更新', function () {
  const env = contentEnv.makeEnv({ attendanceLayout: 'rowsLegacy', content: { 崇拜人數: attRows() } });
  assert.strictEqual(env.sandbox.detectAttendanceTabLayout_(env.contentTabs['崇拜人數'], attDef(env)), 'ROWS_LEGACY');
  // 週報已經有一個合堂值（例如人手補的）：內容表沒有那一欄 → 不可以當成空白清走。
  env.sandbox.writeBulletinWeekField_(DATES[3], 'ATT_COMB_WORSHIP', '199');
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, true, JSON.stringify(imp.data));
  assert.ok(imp.data.lines.indexOf('⚠️ ' + ROWS_NOTICE) !== -1, imp.data.lines.join('\n'));
  assert.strictEqual(String(weekOf(env, DATES[0]).ATT_ENG_WORSHIP), '50');
  assert.strictEqual(String(weekOf(env, DATES[4]).ATT_ENG_WORSHIP), '54');
  assert.strictEqual(String(weekOf(env, DATES[3]).ATT_COMB_WORSHIP), '199', '少了的欄不讀，週報那一格不碰');
  assertWrittenChinese(assert, '匯入提示', [ROWS_NOTICE]);
});

test('CA-13b 未有合堂三欄：填寫介面載入（apiLoadWeek）時自動匯入照做，提示與內容表狀態列都講明要按「更新本季內容表…」', function () {
  const env = contentEnv.makeEnv({ attendanceLayout: 'rowsLegacy', content: { 崇拜人數: attRows() } });
  const load = env.sandbox.apiLoadWeek(DATES[0]);
  assert.strictEqual(load.ok, true, JSON.stringify(load.error));
  assert.strictEqual(load.data.autoImport.reason, '', JSON.stringify(load.data.autoImport));
  assert.deepStrictEqual(plain(load.data.autoImport.notices), [ROWS_NOTICE]);
  assert.strictEqual(String(weekOf(env, DATES[0]).ATT_ENG_WORSHIP), '50', '照常匯入');
  assert.strictEqual(load.data.contentSheet.schemaStatus, 'OK');
  assert.strictEqual(load.data.contentSheet.schemaNotice, ROWS_NOTICE);
});

test('CA-13c 未有合堂三欄：自動同步（runContentAutoSync_）照常匯入，ErrorLog 同一季每日只記一次', function () {
  const env = contentEnv.makeEnv({ attendanceLayout: 'rowsLegacy', content: { 崇拜人數: attRows() },
    config: { WEBAPP_SIMULATED_TODAY: '2027-10-01' } });
  const sb = env.sandbox;
  const times = { FAKE_CONTENT_FILE: '2027-01-01' };
  sb.DriveApp.getFileById = function (id) { return { getLastUpdated: function () { return sb.normalizeDate_(times[id]); } }; };
  const props = {};
  sb.PropertiesService = { getScriptProperties: function () {
    return { getProperty: function (k) { return props[k] === undefined ? null : props[k]; }, setProperty: function (k, v) { props[k] = String(v); },
      deleteProperty: function (k) { delete props[k]; } };
  } };
  function logged() { return sb.readSheet_('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'CONTENT_ATTENDANCE_ROWS_MISSING'; }); }
  const first = sb.runContentAutoSync_({ todayIso: '2027-10-01' });
  const q = first.quarters.filter(function (e) { return e.quarterId === QUARTER_ID; })[0];
  assert.strictEqual(q.status, 'IMPORTED', JSON.stringify(first));
  assert.deepStrictEqual(plain(q.notices), [ROWS_NOTICE]);
  assert.strictEqual(String(weekOf(env, DATES[0]).ATT_ENG_WORSHIP), '50');
  assert.strictEqual(logged().length, 1);
  assert.ok(String(logged()[0].MESSAGE).indexOf(ROWS_NOTICE) !== -1, logged()[0].MESSAGE);
  // 內容表再改（沒有改動要匯入）→ 同一日不再記；翌日再記一次。
  times.FAKE_CONTENT_FILE = '2027-01-02';
  const second = sb.runContentAutoSync_({ todayIso: '2027-10-01' });
  assert.strictEqual(second.quarters.filter(function (e) { return e.quarterId === QUARTER_ID; })[0].status, 'NO_CHANGE');
  assert.strictEqual(logged().length, 1, '同一日只記一次');
  times.FAKE_CONTENT_FILE = '2027-01-03';
  sb.runContentAutoSync_({ todayIso: '2027-10-02' });
  assert.strictEqual(logged().length, 2, '翌日再記一次');
});

test('CA-14 預覽（apiPreviewContentSheetBuild）：講明會重新整理並加上合堂三欄、人數照搬；人手開行的要確認、系統鎖住的不用；預覽一格不寫', function () {
  const env = contentEnv.makeEnv({ attendanceLayout: 'rowsLegacy', content: { 崇拜人數: attRows() } });
  const before = snapshot(env);
  const resp = env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  const text = resp.data.lines.join('\n');
  ['・「崇拜人數」會重新整理成一個崇拜日期一行（' + DATES.length + ' 行），已經填好的人數照搬。',
    '・「崇拜人數」會加上 3 欄：合堂崇拜、合堂祈禱會、合堂兒童（在「有效」之前；合堂主日那一行只填合堂三格，其餘留空）。'].forEach(function (p) {
    assert.ok(text.indexOf(p) !== -1, '預覽缺少：' + p + '\n' + text);
  });
  assert.strictEqual(resp.data.summary.needsMigration, true, '人手開行（未鎖）的要人手確認');
  assertWrittenChinese(assert, '預覽', resp.data.lines);
  assert.strictEqual(snapshot(env), before, '預覽一格不寫');
  // 系統建的（鎖住）：自動做，不用確認。
  const legacyLen = attDef(env).legacyRowKeys.length;
  env.sandbox.ensureContentTabDateLock_(env.contentTabs['崇拜人數'], legacyLen, DATES.length);
  assert.strictEqual(env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID).data.summary.needsMigration, false);
});

test('CA-15 更新（apiRunContentSheetBuild）：新分頁有合堂三欄（「有效」之前）、人數照搬；舊分頁改名隱藏、一格不改；再按一次不變；之後匯入合堂三格', function () {
  const env = contentEnv.makeEnv({ attendanceLayout: 'rowsLegacy', content: { 崇拜人數: attRows() } });
  // 獨立審查 2026-11-03：週報已經有一個合堂值（人手補的）→ 重新整理時帶入新分頁，之後匯入不清走。
  env.sandbox.writeBulletinWeekField_(DATES[4], 'ATT_COMB_PRAYER', '7');
  const old = plain(env.contentTabs['崇拜人數'].__data);
  const resp = env.sandbox.apiRunContentSheetBuild(QUARTER_ID);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  assert.strictEqual(resp.data.ok, true, JSON.stringify(resp.data));
  const retired = env.contentSpreadsheet.getSheetByName('崇拜人數（整理前，已停用）');
  assert.ok(retired && retired.isSheetHidden(), '舊分頁改名隱藏保留');
  assert.deepStrictEqual(plain(retired.__data), old, '舊分頁一格不改');
  const now = env.contentSpreadsheet.getSheetByName('崇拜人數');
  const def = attDef(env);
  assert.deepStrictEqual(plain(now.__data[1].slice(0, def.keys.length)), plain(def.keys));
  assert.deepStrictEqual(plain(now.__data[1].slice(13, 17)), ['ATT_COMB_WORSHIP', 'ATT_COMB_PRAYER', 'ATT_COMB_CHILD', 'ACTIVE']);
  assert.deepStrictEqual(plain(now.__data[0].slice(13, 16)), ['合堂崇拜', '合堂祈禱會', '合堂兒童']);
  DATES.forEach(function (iso, i) { assert.strictEqual(cellOf(now, 'ATT_ENG_WORSHIP', minus7(iso)), i === 1 ? '' : String(50 + i)); });
  [14, 15, 16].forEach(function (c) { assert.strictEqual(now.getRange(3, c).getNumberFormat(), '@', '第 ' + c + ' 欄要純文字'); });
  const lock = now.__protections.filter(function (p) { return p.description === env.sandbox.CONTENT_SHEET_V4_LOCK_DESCRIPTION_; });
  assert.strictEqual(lock.length, 1);
  assert.deepStrictEqual(plain(lock[0].unprotected.map(function (r) { return [r.getRow(), r.getColumn(), r.getNumRows(), r.getNumColumns()]; })),
    [[3, 2, DATES.length, 16]]);
  assert.ok(resp.data.lines.join('\n').indexOf('・「崇拜人數」已加上 3 欄') !== -1, resp.data.lines.join('\n'));
  // 冪等。
  const after = snapshot(env);
  assert.strictEqual(env.sandbox.apiRunContentSheetBuild(QUARTER_ID).data.ok, true);
  assert.strictEqual(snapshot(env), after, '再按一次一格不改');
  // 同工在新欄填合堂三格 → 匯入（崇拜日期 DATES[1] → 印在 DATES[2]）。
  setCell(now, 'ATT_COMB_WORSHIP', DATES[1], '231');
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, true, JSON.stringify(imp.data));
  assert.strictEqual(imp.data.lines.join('\n').indexOf('未有合堂三欄'), -1, '更新之後不再提示');
  assert.strictEqual(String(weekOf(env, DATES[2]).ATT_COMB_WORSHIP), '231');
  assert.strictEqual(String(weekOf(env, DATES[0]).ATT_ENG_WORSHIP), '50');
  assert.strictEqual(cellOf(now, 'ATT_COMB_PRAYER', DATES[3]), '7', '週報已有的合堂值帶入新分頁');
  assert.strictEqual(String(weekOf(env, DATES[4]).ATT_COMB_PRAYER), '7', '匯入不清走');
});

test('CA-16 第 2 行（機器鍵）被改過（位置不明）→ 更新不碰「崇拜人數」（與其他認不出的版面一樣）、匯入整次拒絕', function () {
  const env = contentEnv.makeEnv({ content: { 崇拜人數: attRows() } });
  const sheet = env.contentTabs['崇拜人數'];
  sheet.__data[1][14] = '有人改了';
  assert.strictEqual(env.sandbox.detectAttendanceTabLayout_(sheet, attDef(env)), 'UNKNOWN');
  const before = JSON.stringify(sheet.__data);
  const run = env.sandbox.apiRunContentSheetBuild(QUARTER_ID);
  assert.strictEqual(run.data.ok, true, JSON.stringify(run.data));
  assert.strictEqual(run.data.lines.join('\n').indexOf('加上 3 欄'), -1, '不可以講會加欄');
  assert.strictEqual(JSON.stringify(sheet.__data), before, '「崇拜人數」一格不寫');
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, false, JSON.stringify(imp.data));
  assert.ok(String(imp.data.message).indexOf('內容表「崇拜人數」第 2 行（機器鍵）第 15 欄應該是「ATT_COMB_PRAYER」') !== -1, imp.data.message);
});

test('CA-17 新建的內容表：「崇拜人數」一開始就有合堂三欄；_說明 與註解講明合堂主日只填合堂三格', function () {
  const env = contentEnv.makeEnv({ omitTabs: ['崇拜人數'] });
  const resp = env.sandbox.apiRunContentSheetBuild(QUARTER_ID);
  assert.strictEqual(resp.data.ok, true, JSON.stringify(resp.data));
  const sheet = env.contentSpreadsheet.getSheetByName('崇拜人數');
  assert.deepStrictEqual(plain(sheet.__data[1].slice(13, 16)), ['ATT_COMB_WORSHIP', 'ATT_COMB_PRAYER', 'ATT_COMB_CHILD']);
  assert.strictEqual(sheet.__data.length, 2 + DATES.length, '每個崇拜日期一行');
  const note = String(sheet.getRange(1, 1).getNote());
  assert.ok(note.indexOf('合堂主日（三堂聯合崇拜）那一行只填最後的合堂三格') !== -1, '註解：' + note);
  const help = env.contentSpreadsheet.getSheetByName('_說明').__data.map(function (row) { return row[0]; }).join('\n');
  assert.ok(help.indexOf('合堂主日（三堂聯合崇拜）那一行只填最後的合堂三格（合堂崇拜、合堂祈禱會、合堂兒童），其餘留空') !== -1, help);
  assertWrittenChinese(assert, '說明', [note, help]);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
