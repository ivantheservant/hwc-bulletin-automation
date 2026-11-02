#!/usr/bin/env node
/**
 * tests/contentsheetv4.test.js
 *
 * 內容表 v4（2026-10-30 Ivan 示範之後的決定，src/ContentSheetV4.gs）：
 *   1. 「崇拜程序」只留讀經經文、證道講題、回應詩歌（加備註），一個主日一行；其餘六欄的值先搬入週報。
 *   2. 「崇拜程序」「崇拜人數」一個日期一行、日期欄鎖住；匯入時同一個日期多行 → 那一日不匯入並警告。
 *   3. 「家事報告」「代禱事項」把「連續到」「有效」搬到 B、C 欄（整欄搬移）。
 *   4. 「家事報告」「代禱事項」「財政報告」每日按日期、次序排好；排序前後週報的先後不變。
 *   5. 「有效」留空當作 TRUE。
 *
 * v3 內容表由凍結的 tests/fixtures/legacyContentSheetV3.js 造（不由 src 衍生，bug class 39）。
 * 一律經真正入口：apiPreviewContentSheetBuild／apiRunContentSheetBuild（「更新本季內容表…」）、
 * apiRunQuarterContentImport、apiLoadWeek、dailyQuarterAutoCreateTrigger_、weeklyBulletinSendTrigger_。
 *
 * 執行方式：node tests/contentsheetv4.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const contentEnv = require('./helpers/contentEnv');
const { LEGACY_V3_TAB_DEFS } = require('./fixtures/legacyContentSheetV3');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

const QUARTER_ID = contentEnv.QUARTER_ID;
const [D1, D2, D3, D4, D5] = contentEnv.SERVICE_DATES;

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

function minus7(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

/**
 * 一份 v3 內容表（2026-10-26 至 10-30 各季的樣子）：
 *   - D1：崇拜程序一行，十二欄都有值；週報六欄空白。
 *   - D2：崇拜程序一行，只有講題；週報序樂「週報的序樂」（內容表空白 → 週報保留）。
 *   - D3：一行停用（「停用的講題」）＋一行生效（「講題丙」）。
 *   - D4：兩行生效（以最後一行為準）。
 *   - D5：沒有行（新分頁由週報帶入三欄）。
 */
function makeV3Env(extra) {
  const o = Object.assign({}, extra || {});
  return contentEnv.makeEnv(Object.assign({
    contentLayout: 'v3',
    weekRows: [
      { SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID },
      { SERVICE_DATE: D2, QUARTER_ID: QUARTER_ID, PRELUDE: '週報的序樂' },
      { SERVICE_DATE: D3, QUARTER_ID: QUARTER_ID },
      { SERVICE_DATE: D4, QUARTER_ID: QUARTER_ID },
      { SERVICE_DATE: D5, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '週報的講題' }
    ],
    content: {
      崇拜程序: [
        {
          SERVICE_DATE: D1, SCRIPTURE_REF: '約翰福音 3:16', SERMON_TITLE: '講題甲', RESPONSE_HYMN: '回應甲',
          CHOIR_TITLE: '詩班曲甲', ACTIVE: 'TRUE', NOTES: '備註甲', PRELUDE: '序樂甲', CALL_REF: '詩篇 100:1',
          CALL_TEXT: '宣召經文甲', HYMN_PRAISE: '頌讚甲', CHOIR_LABEL: '詩班獻詩'
        },
        { SERVICE_DATE: D2, SERMON_TITLE: '講題乙', ACTIVE: 'TRUE' },
        { SERVICE_DATE: D3, SERMON_TITLE: '停用的講題', ACTIVE: 'FALSE' },
        { SERVICE_DATE: D3, SERMON_TITLE: '講題丙', ACTIVE: 'TRUE' },
        { SERVICE_DATE: D4, SERMON_TITLE: '講題丁一', ACTIVE: 'TRUE' },
        { SERVICE_DATE: D4, SERMON_TITLE: '講題丁二', ACTIVE: 'TRUE' }
      ],
      家事報告: [
        { SERVICE_DATE: D2, SEQ_NO: '20', TEXT: '乙二十', ACTIVE: 'TRUE' },
        { SERVICE_DATE: D1, SEQ_NO: '', TEXT: '甲留空', ACTIVE: 'TRUE' },
        { SERVICE_DATE: D1, SEQ_NO: '10', TEXT: '甲十連續', REPEAT_UNTIL: D2, ACTIVE: 'TRUE' }
      ],
      代禱事項: [
        { SERVICE_DATE: D1, SEQ_NO: '10', TEXT: '代禱甲', ACTIVE: 'TRUE' }
      ],
      崇拜人數: [
        { SERVICE_DATE: minus7(D2), ATT_ENG_WORSHIP: '50', ACTIVE: 'TRUE' }
      ],
      財政報告: [
        { SERVICE_DATE: D1, SEQ_NO: '10', ROW_LABEL: '奉獻', COL1: '$100', ACTIVE: 'TRUE' }
      ]
    }
  }, o));
}

function tabRows(env, name) {
  const sheet = env.contentSpreadsheet.getSheetByName(name);
  const data = sheet.__data;
  const keys = data[1];
  return plain(data.slice(2).filter(function (r) {
    return r.some(function (v) { return v !== '' && v !== null && v !== undefined; });
  }).map(function (r) {
    const o = {};
    keys.forEach(function (k, i) { if (k) o[k] = r[i] === undefined ? '' : r[i]; });
    return o;
  }));
}

function weekOf(env, iso) {
  return env.sandbox.readSheet_('BulletinWeeks').filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === iso; })[0];
}

function activeTexts(env, sheetName, iso) {
  return env.sandbox.readSheet_(sheetName).filter(function (r) {
    return r.ACTIVE === true && env.sandbox.formatIsoDate_(r.SERVICE_DATE) === iso;
  }).sort(function (a, b) { return Number(a.SEQ_NO) - Number(b.SEQ_NO); }).map(function (r) { return String(r.TEXT); }).slice();
}

function plainTexts(env, sheetName, iso) {
  return plain(activeTexts(env, sheetName, iso));
}

function snapshot(env) {
  return JSON.stringify(env.contentSpreadsheet.getSheets().map(function (s) {
    return {
      name: s.getName(), hidden: s.isSheetHidden(), data: s.__data, note: s.getRange(1, 1).getNote(),
      prot: (s.__protections || []).map(function (p) { return [p.description, p.warningOnly, p.unprotected ? p.unprotected.length : 0]; })
    };
  }));
}

function run(env) {
  const resp = env.sandbox.apiRunContentSheetBuild(QUARTER_ID);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  assert.strictEqual(resp.data.ok, true, JSON.stringify(resp.data));
  return resp.data;
}

function lockOf(sheet) {
  return (sheet.__protections || []).filter(function (p) {
    return p.description === '週報系統：日期欄與標題鎖住，只可以改值的欄（不可以插入或刪除行）';
  });
}

console.log('\n內容表 v3 → v4（真入口）');

test('V4-1 預覽講明會做甚麼；之前匯入整次拒絕（講明要按「更新本季內容表…」）', function () {
  const env = makeV3Env();
  const sb = env.sandbox;
  const imp = sb.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, false, JSON.stringify(imp.data));
  const msg = String(imp.data.message || '');
  ['「崇拜程序」仍然是舊版', '「家事報告」的「連續到」「有效」未搬到 B、C 欄', '「財政報告」少了 2 欄', '更新本季內容表…'].forEach(function (p) {
    assert.ok(msg.indexOf(p) !== -1, '缺少：' + p + '\n' + msg);
  });
  const before = snapshot(env);
  const preview = sb.apiPreviewContentSheetBuild(QUARTER_ID).data;
  const text = preview.lines.join('\n');
  ['【內容表新版面（2026-10-30）】', '「崇拜程序」會只留讀經經文、證道講題、回應詩歌與備註，一個主日一行（5 行）',
    '內容表這六欄的值會先搬入週報（6 格，1 個主日）', '「崇拜程序（舊版 v3，已停用）」',
    '「家事報告」會把「連續到」搬到 B 欄、「有效」搬到 C 欄', '「代禱事項」會把「連續到」搬到 B 欄'].forEach(function (p) {
    assert.ok(text.indexOf(p) !== -1, '預覽缺少：' + p + '\n' + text);
  });
  assert.strictEqual(snapshot(env), before, '預覽一格都不寫');
  assertWrittenChinese(assert, '預覽', preview.lines);
});

test('V4-2 執行：六欄搬入週報（只寫有值的格，週報原有的值不被空白蓋過）；三欄由舊分頁最後一行生效的帶入；D5 由週報帶入', function () {
  const env = makeV3Env();
  const data = run(env);
  const w1 = weekOf(env, D1);
  assert.deepStrictEqual(
    [w1.PRELUDE, w1.CALL_REF, w1.CALL_TEXT, w1.HYMN_PRAISE, w1.CHOIR_TITLE, w1.CHOIR_LABEL],
    ['序樂甲', '詩篇 100:1', '宣召經文甲', '頌讚甲', '詩班曲甲', '詩班獻詩']);
  assert.strictEqual(weekOf(env, D2).PRELUDE, '週報的序樂', '內容表空白不蓋過週報');
  const rows = tabRows(env, '崇拜程序');
  assert.deepStrictEqual(rows.map(function (r) { return r.SERVICE_DATE; }), [D1, D2, D3, D4, D5]);
  assert.deepStrictEqual(Object.keys(rows[0]), ['SERVICE_DATE', 'SCRIPTURE_REF', 'SERMON_TITLE', 'RESPONSE_HYMN', 'NOTES']);
  assert.deepStrictEqual(rows.map(function (r) { return r.SERMON_TITLE; }), ['講題甲', '講題乙', '講題丙', '講題丁二', '週報的講題']);
  assert.strictEqual(rows[0].SCRIPTURE_REF, '約翰福音 3:16');
  assert.strictEqual(rows[0].NOTES, '備註甲');
  const text = data.lines.join('\n');
  assert.ok(text.indexOf('以下 2 行不會搬入新分頁') !== -1, text);
  assert.ok(text.indexOf('已停用（有效＝FALSE）') !== -1 && text.indexOf('同一個日期較早的一行（以最後一行為準）') !== -1, text);
  // 週報那一邊逐格 AuditLog。
  const audits = env.sandbox.readSheet_('AuditLog').filter(function (a) { return a.ACTION === 'CONTENT_SHEET_UPGRADE_V4'; });
  assert.strictEqual(audits.length, 6, JSON.stringify(plain(audits)));
});

test('V4-3 舊「崇拜程序」改名保留：隱藏、A1 註解、警告式保護，資料一格不改；新分頁日期欄鎖住，只留 B 至 E 欄的資料行可以改', function () {
  const env = makeV3Env();
  const oldData = plain(env.contentTabs['崇拜程序'].__data.slice(2));
  run(env);
  const retired = env.contentSpreadsheet.getSheetByName('崇拜程序（舊版 v3，已停用）');
  assert.ok(retired, '舊分頁改名');
  assert.strictEqual(retired.isSheetHidden(), true);
  assert.ok(String(retired.getRange(1, 1).getNote()).indexOf('已停用（2026-10-30 起）') === 0, retired.getRange(1, 1).getNote());
  assert.deepStrictEqual(plain(retired.__data.slice(2)), oldData, '資料一格不改');
  assert.deepStrictEqual(retired.__protections.map(function (p) { return [p.description, p.warningOnly]; }),
    [['週報系統：重新整理之前的舊分頁（已停用）', true]]);
  const sheet = env.contentSpreadsheet.getSheetByName('崇拜程序');
  const lock = lockOf(sheet);
  assert.strictEqual(lock.length, 1);
  assert.strictEqual(lock[0].warningOnly, false, '嚴格保護');
  assert.strictEqual(lock[0].domainEdit, false);
  assert.deepStrictEqual(lock[0].editors, ['tester@x.com'], '只有本系統的帳戶');
  const free = lock[0].unprotected.map(function (r) { return [r.getRow(), r.getColumn(), r.getNumRows(), r.getNumColumns()]; });
  assert.deepStrictEqual(plain(free), [[3, 2, 5, 4]], '第 3 至 7 行、B 至 E 欄');
  // 崇拜人數同樣一個日期一行、鎖住；舊分頁保留。
  const att = tabRows(env, '崇拜人數');
  assert.deepStrictEqual(att.map(function (r) { return r.SERVICE_DATE; }), contentEnv.SERVICE_DATES.map(minus7));
  assert.strictEqual(att[1].ATT_ENG_WORSHIP, '50');
  assert.strictEqual(lockOf(env.contentSpreadsheet.getSheetByName('崇拜人數')).length, 1);
  assert.ok(env.contentSpreadsheet.getSheetByName('崇拜人數（整理前，已停用）'), '崇拜人數舊分頁保留');
});

test('V4-4 家事報告、代禱事項整欄搬：B 欄連續到、C 欄有效，資料跟住欄走；財政報告最後加附註、銀行結餘', function () {
  const env = makeV3Env();
  run(env);
  const ann = env.contentSpreadsheet.getSheetByName('家事報告');
  assert.deepStrictEqual(plain(ann.__data[1].slice(0, 7)), ['SERVICE_DATE', 'REPEAT_UNTIL', 'ACTIVE', 'SEQ_NO', 'TEXT', 'SOURCE', 'SOURCE_SNAPSHOT']);
  assert.deepStrictEqual(plain(ann.__data[0].slice(0, 5)), ['主日日期', '連續到', '有效', '次序', '內容']);
  const rows = tabRows(env, '家事報告');
  const repeat = rows.filter(function (r) { return r.TEXT === '甲十連續'; })[0];
  assert.strictEqual(repeat.REPEAT_UNTIL, D2);
  assert.strictEqual(String(repeat.ACTIVE).toUpperCase(), 'TRUE');
  assert.deepStrictEqual(plain(env.contentSpreadsheet.getSheetByName('代禱事項').__data[1].slice(0, 5)),
    ['SERVICE_DATE', 'REPEAT_UNTIL', 'ACTIVE', 'SEQ_NO', 'TEXT']);
  assert.deepStrictEqual(plain(env.contentSpreadsheet.getSheetByName('財政報告').__data[1].slice(9, 11)), ['FINANCE_NOTE', 'FINANCE_BALANCE']);
  // 之後匯入不再被擋，三欄、清單照用內容表。
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, true, JSON.stringify(imp.data));
  assert.strictEqual(weekOf(env, D4).SERMON_TITLE, '講題丁二');
  assert.deepStrictEqual(plainTexts(env, 'Announcements', D1), ['甲十連續', '甲留空']);
  assert.deepStrictEqual(plainTexts(env, 'Announcements', D2), ['甲十連續', '乙二十']);
});

test('V4-5 執行的數字等於預覽；再按一次一格不改（只排序、版面）', function () {
  const env = makeV3Env();
  const preview = env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID).data;
  run(env);
  const audits = env.sandbox.readSheet_('AuditLog').filter(function (a) { return a.ACTION === 'CONTENT_SHEET_UPGRADE_V4'; });
  assert.ok(preview.lines.join('\n').indexOf('（' + audits.length + ' 格，') !== -1, preview.lines.join('\n'));
  const once = snapshot(env);
  const again = run(env);
  assert.strictEqual(snapshot(env), once, '重跑結果相同');
  assert.strictEqual(again.lines.join('\n').indexOf('【內容表新版面'), -1, again.lines.join('\n'));
  const p2 = env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID).data;
  assert.strictEqual(p2.lines.join('\n').indexOf('【內容表新版面'), -1, '已經是新版：預覽不再講轉換');
});

test('V4-6 自動流程（星期一 weeklyBulletinSendTrigger_）不替人轉換：一格不寫，ErrorLog CONTENT_SHEET_NEEDS_MIGRATION（講明要按「更新本季內容表…」）', function () {
  const env = makeV3Env({ config: { CONTENT_SHEET_INVITE_LEAD_DAYS: '100000', DRY_RUN: 'TRUE' } });
  const before = snapshot(env);
  env.sandbox.weeklyBulletinSendTrigger_();
  assert.strictEqual(snapshot(env), before, '一格不寫');
  const errs = env.sandbox.readSheet_('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'CONTENT_SHEET_NEEDS_MIGRATION'; });
  assert.strictEqual(errs.length, 1, JSON.stringify(plain(env.sandbox.readSheet_('ErrorLog'))));
  ['「崇拜程序」只留讀經經文、證道講題、回應詩歌', '更新本季內容表…'].forEach(function (p) {
    assert.ok(errs[0].MESSAGE.indexOf(p) !== -1, errs[0].MESSAGE);
  });
});

test('V4-7 改名之後建新分頁失敗（中途停止）→ 匯入被擋（上一次更新未做完）→ 重跑由改了名的舊分頁照樣建，結果與一次跑完相同', function () {
  const clean = makeV3Env();
  run(clean);
  const expected = snapshot(clean);
  const env = makeV3Env();
  const realInsert = env.contentSpreadsheet.insertSheet;
  let fired = false;
  env.contentSpreadsheet.insertSheet = function (name) {
    if (name === '崇拜程序' && !fired) { fired = true; throw new Error('注入：建新分頁失敗'); }
    return realInsert.apply(env.contentSpreadsheet, arguments);
  };
  assert.strictEqual(env.sandbox.apiRunContentSheetBuild(QUARTER_ID).ok, false);
  assert.ok(env.contentSpreadsheet.getSheetByName('崇拜程序（舊版 v3，已停用）'), '舊分頁已改名');
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, false);
  assert.ok(String(imp.data.message).indexOf('上一次更新未做完') !== -1, imp.data.message);
  run(env);
  assert.strictEqual(snapshot(env), expected, '重跑之後與一次跑完相同');
  const audits = env.sandbox.readSheet_('AuditLog').filter(function (a) { return a.ACTION === 'CONTENT_SHEET_UPGRADE_V4'; });
  assert.strictEqual(audits.length, 6, '週報那一步不重複寫');
});

test('V4-8 已經是新版之後有人把舊分頁取消隱藏 → 再按「更新本季內容表」只補隱藏，其餘一格不改', function () {
  const env = makeV3Env();
  run(env);
  const once = snapshot(env);
  const retired = env.contentSpreadsheet.getSheetByName('崇拜程序（舊版 v3，已停用）');
  retired.showSheet();
  const again = run(env);
  assert.strictEqual(retired.isSheetHidden(), true);
  assert.ok(again.lines.join('\n').indexOf('「崇拜程序（舊版 v3，已停用）」已補做：隱藏') !== -1, again.lines.join('\n'));
  assert.strictEqual(snapshot(env), once);
});

test('V4-14 日期欄鎖不到（例如 Shared Drive 不准拿走編輯者）→ 整次照樣完成，結果講明、ErrorLog CONTENT_SHEET_LOCK_FAILED', function () {
  const env = makeV3Env();
  const realInsert = env.contentSpreadsheet.insertSheet;
  env.contentSpreadsheet.insertSheet = function (name) {
    const sheet = realInsert.apply(env.contentSpreadsheet, arguments);
    const realProtect = sheet.protect;
    sheet.protect = function () {
      const p = realProtect.apply(sheet, arguments);
      p.removeEditors = function () { throw new Error('注入：不准改編輯者'); };
      return p;
    };
    return sheet;
  };
  const data = run(env);
  const text = data.lines.join('\n');
  assert.ok(text.indexOf('「崇拜程序」的日期欄鎖不到') !== -1 && text.indexOf('「崇拜人數」的日期欄鎖不到') !== -1, text);
  assert.deepStrictEqual(tabRows(env, '崇拜程序').map(function (r) { return r.SERVICE_DATE; }), contentEnv.SERVICE_DATES);
  const errs = env.sandbox.readSheet_('ErrorLog').filter(function (e) { return e.ERROR_CODE === 'CONTENT_SHEET_LOCK_FAILED'; });
  assert.ok(errs.length >= 2, JSON.stringify(plain(errs)));
});

console.log('\n一個日期一行（匯入）');

test('V4-9 「崇拜程序」同一個主日兩行（有權限的帳戶插入）→ 那一日不匯入並警告（講明怎樣整理），其餘主日照常；按「建立本季內容表」整理成一個日期一行', function () {
  const env = makeV3Env();
  run(env);
  const sb = env.sandbox;
  assert.strictEqual(sb.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  const sheet = env.contentSpreadsheet.getSheetByName('崇拜程序');
  const keys = sheet.__data[1];
  const extra = keys.map(function (k) { return k === 'SERVICE_DATE' ? D2 : (k === 'SERMON_TITLE' ? '插入的講題' : ''); });
  sheet.__data.push(extra);
  const r1 = sheet.__data.findIndex(function (row, i) { return i >= 2 && row[0] === D1; });
  sheet.__data[r1][keys.indexOf('SERMON_TITLE')] = '改過的講題甲';
  const imp = sb.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, true, JSON.stringify(imp.data));
  const warnings = Array.from(imp.data.lines || []).join('\n');
  assert.ok(warnings.indexOf('崇拜程序：主日 ' + D2 + ' 有 2 行') !== -1, warnings);
  assert.ok(warnings.indexOf('週報系統 ▸ 內容表 ▸ 建立本季內容表') !== -1, warnings);
  assert.strictEqual(warnings.indexOf('請刪走'), -1, '不可以叫人刪行');
  assert.strictEqual(weekOf(env, D2).SERMON_TITLE, '講題乙', '那一日不匯入');
  assert.strictEqual(weekOf(env, D1).SERMON_TITLE, '改過的講題甲', '其餘主日照常');
  assertWrittenChinese(assert, '重複警告', [warnings]);
  // 整理：以最後一行為準，舊分頁保留。
  run(env);
  const rows = tabRows(env, '崇拜程序');
  assert.deepStrictEqual(rows.map(function (r) { return r.SERVICE_DATE; }), [D1, D2, D3, D4, D5]);
  assert.strictEqual(rows[1].SERMON_TITLE, '插入的講題');
  assert.ok(env.contentSpreadsheet.getSheetByName('崇拜程序（整理前，已停用）'), '整理前的分頁保留');
});

test('V4-10 「有效」留空當作 TRUE（家事報告）；FALSE 照舊不匯入', function () {
  const env = makeV3Env();
  run(env);
  const sheet = env.contentSpreadsheet.getSheetByName('家事報告');
  const keys = sheet.__data[1];
  const row = function (o) { return keys.map(function (k) { return o[k] === undefined ? '' : o[k]; }); };
  sheet.__data.push(row({ SERVICE_DATE: D3, SEQ_NO: '10', TEXT: '有效留空' }));
  sheet.__data.push(row({ SERVICE_DATE: D3, SEQ_NO: '20', TEXT: '有效FALSE', ACTIVE: 'FALSE' }));
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, true, JSON.stringify(imp.data));
  assert.deepStrictEqual(plainTexts(env, 'Announcements', D3), ['有效留空']);
});

console.log('\n每日排序');

test('V4-11 每日觸發器（真入口 dailyQuarterAutoCreateTrigger_）把家事報告按日期、次序排好（次序留空排後）；週報的先後不變；AuditLog 一筆', function () {
  const env = makeV3Env();
  run(env);
  const sb = env.sandbox;
  const sheet = env.contentSpreadsheet.getSheetByName('家事報告');
  const keys = sheet.__data[1];
  const row = function (o) { return keys.map(function (k) { return o[k] === undefined ? '' : o[k]; }); };
  // 新加的行加在最底（未排好）：D2 留空、D1 次序 5。
  sheet.__data.push(row({ SERVICE_DATE: D2, TEXT: '乙留空', ACTIVE: 'TRUE' }));
  sheet.__data.push(row({ SERVICE_DATE: D1, SEQ_NO: '5', TEXT: '甲五', ACTIVE: 'TRUE' }));
  assert.strictEqual(sb.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  const beforeD1 = plainTexts(env, 'Announcements', D1);
  const beforeD2 = plainTexts(env, 'Announcements', D2);
  sb.dailyQuarterAutoCreateTrigger_();
  const texts = tabRows(env, '家事報告').map(function (r) { return r.SERVICE_DATE + ' ' + r.SEQ_NO + ' ' + r.TEXT; });
  assert.deepStrictEqual(texts, [D1 + ' 5 甲五', D1 + ' 10 甲十連續', D1 + '  甲留空', D2 + ' 20 乙二十', D2 + '  乙留空']);
  assert.strictEqual(sb.readSheet_('AuditLog').filter(function (a) { return a.ACTION === 'CONTENT_SHEET_NIGHTLY_SORT'; }).length, 1);
  // 排序之後再匯入，週報的先後與排序前相同。
  assert.strictEqual(sb.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  assert.deepStrictEqual(plainTexts(env, 'Announcements', D1), beforeD1);
  assert.deepStrictEqual(plainTexts(env, 'Announcements', D2), beforeD2);
  // 已經排好：再跑一次一格不寫、不記。
  const once = snapshot(env);
  sb.dailyQuarterAutoCreateTrigger_();
  assert.strictEqual(snapshot(env), once);
  assert.strictEqual(sb.readSheet_('AuditLog').filter(function (a) { return a.ACTION === 'CONTENT_SHEET_NIGHTLY_SORT'; }).length, 1);
});

test('V4-12 排序失敗 → ErrorLog 一筆（季度、原因），建立季度那一段照常；沙盒季度不排', function () {
  const env = makeV3Env();
  run(env);
  const sb = env.sandbox;
  const sheet = env.contentSpreadsheet.getSheetByName('家事報告');
  const keys = sheet.__data[1];
  sheet.__data.push(keys.map(function (k) { return k === 'SERVICE_DATE' ? D1 : (k === 'SEQ_NO' ? '1' : (k === 'TEXT' ? '最前' : '')); }));
  const realGetRange = sheet.getRange;
  sheet.getRange = function () {
    const range = realGetRange.apply(sheet, arguments);
    range.sort = function () { throw new Error('注入：排序失敗'); };
    return range;
  };
  sb.dailyQuarterAutoCreateTrigger_();
  const errs = sb.readSheet_('ErrorLog').filter(function (e) { return e.FUNCTION_NAME === 'runNightlyContentSort_'; });
  assert.strictEqual(errs.length, 1, JSON.stringify(plain(sb.readSheet_('ErrorLog'))));
  assert.ok(String(errs[0].MESSAGE).indexOf(QUARTER_ID) !== -1 && String(errs[0].MESSAGE).indexOf('注入：排序失敗') !== -1, errs[0].MESSAGE);
  sheet.getRange = realGetRange;
  // 沙盒季度：一格不排。
  const env2 = makeV3Env({ config: { SELFTEST_QUARTER_ID: QUARTER_ID } });
  run(env2);
  const s2 = env2.contentSpreadsheet.getSheetByName('家事報告');
  s2.__data.push(s2.__data[1].map(function (k) { return k === 'SERVICE_DATE' ? D1 : (k === 'SEQ_NO' ? '1' : (k === 'TEXT' ? '最前' : '')); }));
  const before = snapshot(env2);
  env2.sandbox.dailyQuarterAutoCreateTrigger_();
  assert.strictEqual(snapshot(env2), before);
});

console.log('\n填寫介面');

test('V4-13 真入口 apiLoadWeek：v4 之後序樂、宣召、詩歌頌讚、詩班可以在介面改；三欄唯讀', function () {
  const env = makeV3Env();
  run(env);
  const resp = env.sandbox.apiLoadWeek(D1);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  const ro = Array.from(resp.data.readOnly.readOnlyFields.week);
  ['SCRIPTURE_REF', 'SERMON_TITLE', 'RESPONSE_HYMN'].forEach(function (k) { assert.ok(ro.indexOf(k) !== -1, k); });
  ['PRELUDE', 'CALL_REF', 'CALL_TEXT', 'HYMN_PRAISE', 'CHOIR_TITLE', 'CHOIR_LABEL'].forEach(function (k) {
    assert.strictEqual(ro.indexOf(k), -1, k);
  });
  assert.strictEqual(resp.data.week.PRELUDE, '序樂甲', '搬入週報的值在介面看得到');
});

console.log('\n獨立審查 2026-10-30 的修正');

function failResult(resp) {
  return resp.ok ? resp.data : (resp.error || {});
}

test('V4-15 家事報告、代禱事項一次過搬兩欄（每張分頁一次 moveColumns）；第 2 行既不是舊版亦不是新版 → 整次拒絕，一格不寫', function () {
  const env = makeV3Env();
  const calls = [];
  ['家事報告', '代禱事項'].forEach(function (name) {
    const sheet = env.contentSpreadsheet.getSheetByName(name);
    const real = sheet.moveColumns;
    sheet.moveColumns = function (spec, dest) { calls.push(name + ':' + dest); return real.apply(sheet, arguments); };
  });
  run(env);
  assert.deepStrictEqual(calls, ['家事報告:2', '代禱事項:2']);
  // 以前分兩次搬：第二次失敗之後第 2 行是 A、D、B、C、E——既不是 v3 亦不是 v4。
  const env2 = makeV3Env();
  const ann = env2.contentSpreadsheet.getSheetByName('家事報告');
  ann.moveColumns(ann.getRange('D:D'), 2);
  const before = snapshot(env2);
  const weeksBefore = JSON.stringify(env2.sandbox.readSheet_('BulletinWeeks'));
  const preview = env2.sandbox.apiPreviewContentSheetBuild(QUARTER_ID);
  assert.ok(JSON.stringify(preview).indexOf('「家事報告」第 2 行') !== -1, JSON.stringify(preview));
  const data = failResult(env2.sandbox.apiRunContentSheetBuild(QUARTER_ID));
  assert.strictEqual(data.ok, false, JSON.stringify(data));
  assert.ok(String(data.message).indexOf('「家事報告」第 2 行') !== -1 && String(data.message).indexOf('一格都沒有寫') !== -1, data.message);
  assert.strictEqual(snapshot(env2), before, '內容表一格不寫');
  assert.strictEqual(JSON.stringify(env2.sandbox.readSheet_('BulletinWeeks')), weeksBefore, '週報一格不寫');
  assertWrittenChinese(assert, '拒絕訊息', [data.message]);
});

test('V4-16 新「崇拜程序」資料行寫好、第 1、2 行未寫就停止 → 重跑補回第 1、2 行與鎖，結果與一次跑完相同', function () {
  const clean = makeV3Env();
  run(clean);
  const expected = snapshot(clean);
  const env = makeV3Env();
  const real = env.sandbox.applyContentTabLayout_;
  let fired = false;
  env.sandbox.applyContentTabLayout_ = function (sheet, tabDef) {
    if (!fired && tabDef && tabDef.tabName === '崇拜程序' && tabDef.keys.length === 5) {
      fired = true;
      throw new Error('注入：寫第 1、2 行之前停止');
    }
    return real.apply(this, arguments);
  };
  assert.strictEqual(env.sandbox.apiRunContentSheetBuild(QUARTER_ID).ok, false);
  assert.strictEqual(fired, true);
  env.sandbox.applyContentTabLayout_ = real;
  run(env);
  assert.strictEqual(snapshot(env), expected, '重跑之後與一次跑完相同（v3 的值沒有被週報的值蓋過）');
  // 寫資料行時停止（第 1、2 行仍然是空的）→ 重跑由改了名的 v3 舊分頁再建；以前先寫第 1、2 行，重跑就當成已經是
  //    新版，由週報重建，講題乙、丙、丁全部帶不過來。
  const env2 = makeV3Env();
  const realRows = env2.sandbox.writeContentRows_;
  let fired2 = false;
  env2.sandbox.writeContentRows_ = function (sheet) {
    if (!fired2 && String(sheet.getName()) === '崇拜程序') { fired2 = true; throw new Error('注入：寫資料行時停止'); }
    return realRows.apply(this, arguments);
  };
  assert.strictEqual(env2.sandbox.apiRunContentSheetBuild(QUARTER_ID).ok, false);
  assert.strictEqual(fired2, true);
  env2.sandbox.writeContentRows_ = realRows;
  run(env2);
  assert.strictEqual(snapshot(env2), expected, '重跑之後與一次跑完相同');
});

test('V4-17 重新整理改名之後、寫資料行之前停止 → 重跑由最新的「…（整理前，已停用）」再建，不會用回 v3 舊分頁；崇拜人數同理', function () {
  function prepare() {
    const e = makeV3Env();
    run(e);
    const ws = e.contentSpreadsheet.getSheetByName('崇拜程序');
    const keys = ws.__data[1];
    ws.__data.push(keys.map(function (k) { return k === 'SERVICE_DATE' ? D2 : (k === 'SERMON_TITLE' ? '插入的講題' : ''); }));
    const r1 = ws.__data.findIndex(function (row, i) { return i >= 2 && row[0] === D1; });
    ws.__data[r1][keys.indexOf('SERMON_TITLE')] = '改過的講題甲';
    const at = e.contentSpreadsheet.getSheetByName('崇拜人數');
    const ak = at.__data[1];
    const ar = at.__data.findIndex(function (row, i) { return i >= 2 && row[0] === minus7(D3); });
    at.__data[ar][ak.indexOf('ATT_ENG_WORSHIP')] = '77';
    at.__data.push(ak.map(function (k) {
      return k === 'SERVICE_DATE' ? minus7(D4) : (k === 'ATT_ENG_WORSHIP' ? '66' : (k === 'ACTIVE' ? 'TRUE' : ''));
    }));
    return e;
  }
  const clean = prepare();
  run(clean);
  const cleanRows = tabRows(clean, '崇拜程序');
  assert.deepStrictEqual([cleanRows[0].SERMON_TITLE, cleanRows[1].SERMON_TITLE], ['改過的講題甲', '插入的講題'], '對照');
  const expected = snapshot(clean);

  const env = prepare();
  const real = env.sandbox.writeContentRows_;
  const failed = [];
  env.sandbox.writeContentRows_ = function (sheet) {
    const name = String(sheet.getName());
    if ((name === '崇拜程序' || name === '崇拜人數') && failed.indexOf(name) === -1) {
      failed.push(name);
      throw new Error('注入：寫資料行之前停止');
    }
    return real.apply(this, arguments);
  };
  assert.strictEqual(env.sandbox.apiRunContentSheetBuild(QUARTER_ID).ok, false, '第一次：崇拜程序停止');
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, false);
  assert.ok(String(imp.data.message).indexOf('上一次更新未做完') !== -1, imp.data.message);
  const p = env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID).data;
  assert.ok(p.lines.join('\n').indexOf('「崇拜程序」上一次重新整理未做完，會由「崇拜程序（整理前，已停用）」再建一次') !== -1, p.lines.join('\n'));
  assertWrittenChinese(assert, '預覽', p.lines);
  assert.strictEqual(env.sandbox.apiRunContentSheetBuild(QUARTER_ID).ok, false, '第二次：崇拜人數停止');
  assert.deepStrictEqual(failed, ['崇拜程序', '崇拜人數']);
  env.sandbox.writeContentRows_ = real;
  run(env);
  assert.strictEqual(snapshot(env), expected, '重跑之後與一次跑完相同');
});

test('V4-18 週報已經有另一個值（例如在填寫介面改過）→ 保留週報的值，預覽與結果列出兩邊的值；週報空白的格照搬', function () {
  const env = makeV3Env({
    weekRows: [
      { SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, PRELUDE: '介面改的序樂', CALL_REF: '詩篇 100:1' },
      { SERVICE_DATE: D2, QUARTER_ID: QUARTER_ID, PRELUDE: '週報的序樂' },
      { SERVICE_DATE: D3, QUARTER_ID: QUARTER_ID },
      { SERVICE_DATE: D4, QUARTER_ID: QUARTER_ID },
      { SERVICE_DATE: D5, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '週報的講題' }
    ]
  });
  const preview = env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID).data.lines.join('\n');
  ['內容表這六欄的值會先搬入週報（4 格，1 個主日）', '以下 1 格週報已經有另一個值',
    D1 + '「序樂」：週報「介面改的序樂」，內容表「序樂甲」'].forEach(function (t) {
    assert.ok(preview.indexOf(t) !== -1, '預覽缺少：' + t + '\n' + preview);
  });
  run(env);
  const w1 = weekOf(env, D1);
  assert.strictEqual(w1.PRELUDE, '介面改的序樂', '週報的值保留');
  assert.deepStrictEqual([w1.CALL_TEXT, w1.HYMN_PRAISE, w1.CHOIR_TITLE, w1.CHOIR_LABEL], ['宣召經文甲', '頌讚甲', '詩班曲甲', '詩班獻詩']);
});

test('V4-19 被試算表轉成日期／時間的格：新分頁用週報現有的值並列出來；之後匯入不會把週報那一格清空', function () {
  const env = makeV3Env({
    weekRows: [
      { SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, SCRIPTURE_REF: '約翰福音 3:16', PRELUDE: '週報的序樂一' },
      { SERVICE_DATE: D2, QUARTER_ID: QUARTER_ID, ATT_ENG_WORSHIP: '45' },
      { SERVICE_DATE: D3, QUARTER_ID: QUARTER_ID },
      { SERVICE_DATE: D4, QUARTER_ID: QUARTER_ID },
      { SERVICE_DATE: D5, QUARTER_ID: QUARTER_ID }
    ]
  });
  const ws = env.contentSpreadsheet.getSheetByName('崇拜程序');
  const keys = ws.__data[1];
  const r1 = ws.__data.findIndex(function (row, i) { return i >= 2 && row[0] === D1; });
  ws.__data[r1][keys.indexOf('SCRIPTURE_REF')] = new Date(1899, 11, 30, 3, 16);
  ws.__data[r1][keys.indexOf('PRELUDE')] = new Date(1899, 11, 30, 9, 30);
  const at = env.contentSpreadsheet.getSheetByName('崇拜人數');
  const ak = at.__data[1];
  const ar = at.__data.findIndex(function (row, i) { return i >= 2 && row[0] === minus7(D2); });
  at.__data[ar][ak.indexOf('ATT_ENG_WORSHIP')] = new Date(1900, 0, 14);
  const data = run(env);
  const text = data.lines.join('\n');
  ['以下 3 格被試算表轉成日期／時間格式', '崇拜程序第 ' + (r1 + 1) + ' 行（' + D1 + '）「讀經經文」：用週報的「約翰福音 3:16」',
    '「序樂」：用週報的「週報的序樂一」', '崇拜人數第 ' + (ar + 1) + ' 行（' + minus7(D2) + '）「英語堂崇拜」：用週報的「45」'].forEach(function (t) {
    assert.ok(text.indexOf(t) !== -1, '結果缺少：' + t + '\n' + text);
  });
  assertWrittenChinese(assert, '結果', data.lines);
  assert.strictEqual(tabRows(env, '崇拜程序')[0].SCRIPTURE_REF, '約翰福音 3:16');
  assert.strictEqual(tabRows(env, '崇拜人數')[1].ATT_ENG_WORSHIP, '45');
  assert.strictEqual(weekOf(env, D1).PRELUDE, '週報的序樂一');
  assert.strictEqual(env.sandbox.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  assert.strictEqual(weekOf(env, D1).SCRIPTURE_REF, '約翰福音 3:16', '匯入之後週報那一格仍然在');
  assert.strictEqual(String(weekOf(env, D2).ATT_ENG_WORSHIP), '45');
});

test('V4-20 第 1、2 行被清走：「崇拜人數」下面有資料 → 照現行欄位補回第 1、2 行，人數不清走；「家事報告」分不出新舊次序 → 整次拒絕', function () {
  const env = makeV3Env();
  run(env);
  const at = env.contentSpreadsheet.getSheetByName('崇拜人數');
  // v4 之後才填的人數（改了名的舊分頁沒有）：清走第 1、2 行之後仍然要在。
  const r3 = at.__data.findIndex(function (row, i) { return i >= 2 && row[0] === minus7(D3); });
  at.__data[r3][at.__data[1].indexOf('ATT_ENG_WORSHIP')] = '99';
  const before = tabRows(env, '崇拜人數');
  at.__data[0] = at.__data[0].map(function () { return ''; });
  at.__data[1] = at.__data[1].map(function () { return ''; });
  run(env);
  assert.deepStrictEqual(tabRows(env, '崇拜人數'), before, '人數不清走、第 1、2 行補回');
  assert.strictEqual(env.contentSpreadsheet.getSheetByName('崇拜人數（整理前，已停用）2'), null, '不用重建');
  const ann = env.contentSpreadsheet.getSheetByName('家事報告');
  ann.__data[0] = ann.__data[0].map(function () { return ''; });
  ann.__data[1] = ann.__data[1].map(function () { return ''; });
  const snap = snapshot(env);
  const data = failResult(env.sandbox.apiRunContentSheetBuild(QUARTER_ID));
  assert.strictEqual(data.ok, false, JSON.stringify(data));
  assert.ok(String(data.message).indexOf('「家事報告」第 2 行') !== -1, data.message);
  assert.strictEqual(snapshot(env), snap, '一格不寫');
});

test('V4-21 某一日在舊分頁只有停用的行（例如示範樣本設了有效＝FALSE）→ 新分頁那一日留空，不由週報帶回；完全沒有行的照舊由週報帶入', function () {
  const env = makeV3Env({
    weekRows: [
      { SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID },
      { SERVICE_DATE: D2, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '樣本講題', SCRIPTURE_REF: '樣本經文' },
      { SERVICE_DATE: D3, QUARTER_ID: QUARTER_ID },
      { SERVICE_DATE: D4, QUARTER_ID: QUARTER_ID },
      { SERVICE_DATE: D5, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '週報的講題' }
    ]
  });
  const ws = env.contentSpreadsheet.getSheetByName('崇拜程序');
  const keys = ws.__data[1];
  const r2 = ws.__data.findIndex(function (row, i) { return i >= 2 && row[0] === D2; });
  ws.__data[r2][keys.indexOf('SERMON_TITLE')] = '樣本講題';
  ws.__data[r2][keys.indexOf('ACTIVE')] = 'FALSE';
  run(env);
  const rows = tabRows(env, '崇拜程序');
  assert.deepStrictEqual([rows[1].SERMON_TITLE, rows[1].SCRIPTURE_REF], ['', ''], '只有停用的行：留空');
  assert.strictEqual(rows[4].SERMON_TITLE, '週報的講題', '完全沒有行：由週報帶入');
  assert.strictEqual(env.sandbox.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  assert.strictEqual(String(weekOf(env, D2).SERMON_TITLE || ''), '', '之後匯入：週報那一日亦清空（與內容表一致）');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
