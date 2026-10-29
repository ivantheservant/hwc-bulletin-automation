#!/usr/bin/env node
/**
 * tests/finance.test.js
 *
 * 財政報告（2026-10-30 Ivan：「財政報告：全部修正」，src/FinanceReports.gs）：
 *   - 一期可以有「綜合收支」（四個數字欄）與「特殊海外奉獻及慈惠基金」（兩個數字欄）兩個報告；
 *   - 「報告標題」「附註」「銀行結餘」由內容表匯入（以前「報告標題」沒有匯入，bug class 2）；
 *   - Word 每款各自一張表，沒有那一款就整張不印（一行都沒有的表格整張拿走）；
 *   - 草稿預覽頁、電郵、填寫介面用同一份標題與表頭。
 *
 * 真正入口：apiRunQuarterContentImport、apiLoadWeek、generateBulletinDocx_、buildPreviewPage_。
 *
 * 執行方式：node tests/finance.test.js
 */

'use strict';

const assert = require('assert');
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
    console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n    ') : err));
  }
}
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function row(label, c1, c2, c3, c4, extra) {
  return Object.assign({ rowLabel: label, specialOverseas: c1, hardship: c2, col3: c3 || '', col4: c4 || '', title: '', note: '', balance: '' }, extra || {});
}

/** 2026-06-14 那一期的樣子：綜合收支（沒有填標題）＋特殊海外奉獻及慈惠基金（第一行有標題）。 */
function june14Rows() {
  return [
    row('總收入', '12,345', '23,456', '0', '0', { note: '*收入:  常費及感恩奉獻 (00) $10,000', balance: '截至5月份/2026 銀行結餘 ：$123,456。' }),
    row('總支出', '13,579', '24,680', '0', '0'),
    row('至本月盈餘/(虧損)', '(1,234)', '(1,224)', '0', '0'),
    row('上月結存', '$1.11', '$2,222.22', '', '', { title: '特殊海外奉獻及慈惠基金2026年5月份財政報告', note: '附註：特殊海外奉獻：按計劃將款項全數匯款。' }),
    row('奉獻收入', '100.00', '0.00'),
    row('利息收入', '0.49', '3.65')
  ];
}

console.log('\n分成兩個報告（純函式）');

test('F-1 一期兩款：綜合收支（沒有標題 → 用 Config 樣式、月份＝上一個月）＋特殊海外奉獻及慈惠基金（標題照填）；附註、結餘跟住各自的報告', function () {
  const sb = makeWordEnv({}).sandbox;
  const r = plain(sb.buildFinanceReports_(june14Rows(), { isoDate: '2026-06-14' }));
  assert.strictEqual(r.main.kind, 'MAIN');
  assert.strictEqual(r.main.title, '聖道堂綜合收支財務報告-2026年 5月份');
  assert.strictEqual(r.main.titleFromPattern, true);
  assert.deepStrictEqual(r.main.rows.map(function (x) { return x.label; }), ['總收入', '總支出', '至本月盈餘/(虧損)']);
  assert.strictEqual(r.main.rows[0].col4, '0');
  assert.strictEqual(r.main.note, '*收入:  常費及感恩奉獻 (00) $10,000');
  assert.strictEqual(r.main.balance, '截至5月份/2026 銀行結餘 ：$123,456。');
  assert.strictEqual(r.special.kind, 'SPECIAL');
  assert.strictEqual(r.special.title, '特殊海外奉獻及慈惠基金2026年5月份財政報告');
  assert.deepStrictEqual(r.special.rows.map(function (x) { return x.label; }), ['上月結存', '奉獻收入', '利息收入']);
  assert.strictEqual(r.special.note, '附註：特殊海外奉獻：按計劃將款項全數匯款。');
  assert.deepStrictEqual(r.warnings, []);
});

test('F-2 只有特殊海外奉獻及慈惠基金、沒有填標題 → 按欄三欄四空白認出款式，用特殊款的預設標題；有標題但不含關鍵詞 → 綜合收支', function () {
  const sb = makeWordEnv({}).sandbox;
  const r = plain(sb.buildFinanceReports_([row('上月結存', '$3.33', '$4,444.44'), row('奉獻收入', '0.00', '0.00')], { isoDate: '2026-03-08' }));
  assert.strictEqual(r.main, null);
  assert.strictEqual(r.special.title, '特殊海外奉獻及慈惠基金2026年2月份財政報告');
  const r2 = plain(sb.buildFinanceReports_([row('總收入', '1', '2', '', '', { title: '財政部消息：綜合收支' })], { isoDate: '2026-03-08' }));
  assert.strictEqual(r2.main.title, '財政部消息：綜合收支');
  assert.strictEqual(r2.special, null);
  // Config 改關鍵詞與樣式。
  const r3 = plain(sb.buildFinanceReports_([row('甲', '1', '2', '', '', { title: '慈善基金報告' })],
    { isoDate: '2026-03-08', specialKeywords: '慈善', specialTitlePattern: '基金{{MONTH}}月' }));
  assert.strictEqual(r3.special.title, '慈善基金報告');
  const r4 = plain(sb.buildFinanceReports_([row('甲', '1', '2')], { isoDate: '2026-01-11', specialTitlePattern: '基金{{YEAR}}-{{MONTH}}' }));
  assert.strictEqual(r4.special.title, '基金2025-12', '1 月的上一個月是去年 12 月');
  assert.deepStrictEqual(plain(sb.buildFinanceReports_([], { isoDate: '2026-03-08' })), { main: null, special: null, warnings: [] });
});

test('F-3 警告：同一款兩個報告（只印第一個）；特殊款填了欄三欄四（不會印）；沒有標題而有些行只填兩欄（可能漏了第二個報告的標題）', function () {
  const sb = makeWordEnv({}).sandbox;
  const two = plain(sb.buildFinanceReports_([
    row('甲', '1', '2', '3', '4', { title: '綜合收支一' }), row('乙', '1', '2', '3', '4', { title: '綜合收支二' })
  ], { isoDate: '2026-06-14' }));
  assert.strictEqual(two.main.title, '綜合收支一');
  assert.deepStrictEqual(two.warnings.map(function (w) { return w.code; }), ['FINANCE_EXTRA_REPORT']);
  const extra = plain(sb.buildFinanceReports_([row('上月結存', '1', '2', '3', '', { title: '慈惠基金' })], { isoDate: '2026-06-14' }));
  assert.deepStrictEqual(extra.warnings.map(function (w) { return w.code; }), ['FINANCE_SPECIAL_EXTRA_COLUMNS']);
  const mixed = plain(sb.buildFinanceReports_([row('總收入', '1', '2', '3', '4'), row('上月結存', '1', '2')], { isoDate: '2026-06-14' }));
  assert.strictEqual(mixed.main.rows.length, 2);
  assert.deepStrictEqual(mixed.warnings.map(function (w) { return w.code; }), ['FINANCE_MIXED_COLUMNS']);
  assertWrittenChinese(assert, '財政警告', two.warnings.concat(extra.warnings, mixed.warnings).map(function (w) { return w.message; }));
});

console.log('\n內容表匯入（真入口）');

test('F-4 apiRunQuarterContentImport：報告標題、附註、銀行結餘匯入 Finance；apiLoadWeek 的財政清單有全部欄', function () {
  const D1 = contentEnv.SERVICE_DATES[0];
  const env = contentEnv.makeEnv({
    content: {
      財政報告: [
        { SERVICE_DATE: D1, SEQ_NO: '10', ROW_LABEL: '總收入', COL1: '12,345', COL2: '23,456', COL3: '0', COL4: '0', ACTIVE: 'TRUE',
          FINANCE_NOTE: '*收入: 常費', FINANCE_BALANCE: '截至9月份 銀行結餘：$123,456。' },
        { SERVICE_DATE: D1, SEQ_NO: '20', TITLE_OVERRIDE: '特殊海外奉獻及慈惠基金2027年9月份財政報告', ROW_LABEL: '上月結存',
          COL1: '$1.11', COL2: '$2,222.22', ACTIVE: 'TRUE', FINANCE_NOTE: '附註：甲' },
        { SERVICE_DATE: D1, SEQ_NO: '30', ROW_LABEL: '利息收入', COL1: '0.49', COL2: '3.65', ACTIVE: '' }
      ]
    }
  });
  const sb = env.sandbox;
  const imp = sb.apiRunQuarterContentImport(contentEnv.QUARTER_ID);
  assert.strictEqual(imp.data.ok, true, JSON.stringify(imp.data));
  const rows = sb.readSheet('Finance').filter(function (r) { return r.ACTIVE === true; });
  assert.strictEqual(rows.length, 3, '「有效」留空當作 TRUE');
  assert.strictEqual(rows[0].REPORT_NOTE, '*收入: 常費');
  assert.strictEqual(rows[0].REPORT_BALANCE, '截至9月份 銀行結餘：$123,456。');
  assert.strictEqual(rows[1].REPORT_TITLE, '特殊海外奉獻及慈惠基金2027年9月份財政報告');
  const model = sb.buildBulletinModel_(D1);
  assert.strictEqual(model.financeReports.main.title, '聖道堂綜合收支財務報告-2027年 9月份');
  assert.strictEqual(model.financeReports.special.rows.length, 2);
  assert.deepStrictEqual(plain(model.financeReports.columnLabels.main), ['9月份實際數字', '截至本月實際數字', '截至本月預算', '全年預算']);
  const load = sb.apiLoadWeek(D1);
  assert.strictEqual(load.ok, true, JSON.stringify(load.error));
  const fin = plain(load.data.lists.finance);
  assert.deepStrictEqual(Object.keys(fin[0]).sort(),
    ['COL3', 'COL4', 'COL_HARDSHIP', 'COL_SPECIAL_OVERSEAS', 'REPORT_BALANCE', 'REPORT_NOTE', 'REPORT_TITLE', 'ROW_LABEL', 'seqNo'].sort());
  assert.strictEqual(fin[1].REPORT_TITLE, '特殊海外奉獻及慈惠基金2027年9月份財政報告');
});

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

/** 範本的財政部分（2026-10-30 起的寫法，見 docs/佔位符對照表.md）。 */
function financeTemplate() {
  const c = function (t) { return fx.cell(fx.para(fx.run(t))); };
  return buildFakeDocx(fx.documentXml(
    fx.para(fx.run('{{SERMON_TITLE}}'))
    + fx.para(fx.run('{{#IFP:FINANCE_MAIN_TITLE}}{{FINANCE_MAIN_TITLE}}'))
    + fx.table([
      fx.row([c('{{#IF:FINANCE_MAIN_TITLE}}'), c('{{FINANCE_MAIN_HEAD1}}'), c('{{FINANCE_MAIN_HEAD2}}'), c('{{FINANCE_MAIN_HEAD3}}'), c('{{FINANCE_MAIN_HEAD4}}')]),
      fx.row([c('{{#EACH:FINANCE_MAIN}}{{FINANCE_MAIN.LABEL}}'), c('{{FINANCE_MAIN.COL1}}'), c('{{FINANCE_MAIN.COL2}}'), c('{{FINANCE_MAIN.COL3}}'), c('{{FINANCE_MAIN.COL4}}')])
    ])
    + fx.para(fx.run('{{#IFP:FINANCE_MAIN_NOTE}}{{FINANCE_MAIN_NOTE}}'))
    + fx.para(fx.run('{{#IFP:FINANCE_MAIN_BALANCE}}{{FINANCE_MAIN_BALANCE}}'))
    + fx.para(fx.run('{{#IFP:FINANCE_SPECIAL_TITLE}}{{FINANCE_SPECIAL_TITLE}}'))
    + fx.table([
      fx.row([c('{{#IF:FINANCE_SPECIAL_TITLE}}'), c('{{FINANCE_SPECIAL_HEAD1}}'), c('{{FINANCE_SPECIAL_HEAD2}}')]),
      fx.row([c('{{#EACH:FINANCE_SPECIAL}}{{FINANCE_SPECIAL.LABEL}}'), c('{{FINANCE_SPECIAL.COL1}}'), c('{{FINANCE_SPECIAL.COL2}}')])
    ])
    + fx.para(fx.run('{{#IFP:FINANCE_SPECIAL_NOTE}}{{FINANCE_SPECIAL_NOTE}}'))
  ));
}

function financeRow(seq, label, c1, c2, c3, c4, extra) {
  return Object.assign({
    SERVICE_DATE: new Date(2027, 10, 7), SEQ_NO: seq, ROW_LABEL: label, COL_SPECIAL_OVERSEAS: c1, COL_HARDSHIP: c2,
    COL3: c3 || '', COL4: c4 || '', COL5: '', ACTIVE: true, REPORT_TITLE: '', REPORT_NOTE: '', REPORT_BALANCE: ''
  }, extra || {});
}

function wordEnvWithFinance(financeRows) {
  const env = makeWordEnv({
    driveOptions: { files: { FAKE_TEMPLATE_ID_NORMAL: financeTemplate() } },
    weekRows: [
      { SERVICE_DATE: D, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT', SERMON_TITLE: '講題一' },
      { SERVICE_DATE: D_NEXT, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 2, STATUS: 'DRAFT', SERMON_TITLE: '講題二' }
    ]
  });
  env.sandbox.writeSheet('Finance', financeRows);
  return env;
}

test('F-5 兩款都有：兩張表各自標題、表頭（Config）、行；特殊款只有兩個數字欄；沒有殘留佔位符', function () {
  const env = wordEnvWithFinance([
    financeRow(10, '總收入', '12,345', '23,456', '0', '0', { REPORT_NOTE: '*收入: 常費', REPORT_BALANCE: '截至10月份 銀行結餘：$1。' }),
    financeRow(20, '上月結存', '$1.11', '$2,222.22', '', '', { REPORT_TITLE: '特殊海外奉獻及慈惠基金2027年10月份財政報告', REPORT_NOTE: '附註：乙' })
  ]);
  const r = env.sandbox.generateBulletinDocx_(D);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const xml = documentXmlOf(r.blob);
  const text = visibleText(xml);
  ['聖道堂綜合收支財務報告-2027年 10月份', '10月份實際數字', '全年預算', '總收入|12,345|23,456|0|0', '*收入: 常費', '截至10月份 銀行結餘：$1。',
    '特殊海外奉獻及慈惠基金2027年10月份財政報告', '特殊海外奉獻|慈惠', '上月結存|$1.11|$2,222.22', '附註：乙'].forEach(function (p) {
    assert.ok(text.indexOf(p) !== -1, '缺少：' + p + '\n' + text);
  });
  assert.strictEqual((xml.match(/<w:tbl>/g) || []).length, 2);
  assert.ok(xml.indexOf('{{') === -1, '不可以殘留佔位符');
});

test('F-6 只有特殊款：綜合收支整段不印（標題段落、表頭、整張表、附註）；Word 檔沒有一行都沒有的表格', function () {
  const env = wordEnvWithFinance([financeRow(10, '上月結存', '$3.33', '$4,444.44')]);
  const r = env.sandbox.generateBulletinDocx_(D);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const xml = documentXmlOf(r.blob);
  const text = visibleText(xml);
  assert.strictEqual(text.indexOf('綜合收支'), -1, text);
  assert.strictEqual(text.indexOf('實際數字'), -1, text);
  assert.ok(text.indexOf('特殊海外奉獻及慈惠基金2027年10月份財政報告') !== -1, text);
  assert.strictEqual((xml.match(/<w:tbl>/g) || []).length, 1, '綜合收支那張表整張拿走');
  const tables = xml.split('<w:tbl>').slice(1);
  tables.forEach(function (t) { assert.ok(t.split('</w:tbl>')[0].indexOf('<w:tr>') !== -1, '每一張表都要有行'); });
});

test('F-7 這一期沒有財政報告：兩款都不印，表格全部拿走', function () {
  const env = wordEnvWithFinance([]);
  const r = env.sandbox.generateBulletinDocx_(D);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const xml = documentXmlOf(r.blob);
  assert.strictEqual(xml.indexOf('<w:tbl>'), -1);
  assert.strictEqual(visibleText(xml).replace(/\|/g, ''), '講題一');
});

test('F-8 removeRowlessTables_：表格在儲存格內、拿走之後那一格沒有段落 → 補一個空段落；有行的表格不碰', function () {
  const sb = makeWordEnv({}).sandbox;
  const inner = '<w:tbl><w:tblPr/></w:tbl>';
  const xml = fx.documentXml(fx.table([fx.row([fx.cell(inner)])]) + fx.table([fx.row([fx.cell(fx.para(fx.run('甲')))])]));
  const out = sb.removeRowlessTables_(xml);
  assert.strictEqual(out.removed, 1);
  assert.ok(out.xml.indexOf('<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p/></w:tc>') !== -1, out.xml);
  assert.ok(out.xml.indexOf('甲') !== -1);
  assert.strictEqual(sb.removeRowlessTables_(fx.documentXml(fx.para(fx.run('乙')))).removed, 0);
});

console.log('\n草稿預覽頁');

test('F-9 真入口 buildPreviewPage_：兩款各自一個區塊（標題、表頭與 Word 同一份），附註、結餘印在表下', function () {
  const env = wordEnvWithFinance([
    financeRow(10, '總收入', '12,345', '23,456', '0', '0', { REPORT_BALANCE: '截至10月份 銀行結餘：$1。' }),
    financeRow(20, '上月結存', '$1.11', '$2,222.22', '', '', { REPORT_TITLE: '特殊海外奉獻及慈惠基金2027年10月份財政報告' })
  ]);
  const page = env.sandbox.buildPreviewPage_(D);
  assert.strictEqual(page.ok, true, JSON.stringify(page).slice(0, 500));
  const html = String(page.html);
  ['財政報告：聖道堂綜合收支財務報告-2027年 10月份', '<th>10月份實際數字</th>', '截至10月份 銀行結餘：$1。',
    '財政報告：特殊海外奉獻及慈惠基金2027年10月份財政報告', '<th>特殊海外奉獻</th><th>慈惠</th>'].forEach(function (p) {
    assert.ok(html.indexOf(p) !== -1, '缺少：' + p);
  });
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
