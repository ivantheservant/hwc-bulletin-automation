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
  return env.sandbox.readSheet('BulletinWeeks').filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === iso; })[0];
}

function activeTexts(env, sheetName, iso) {
  return env.sandbox.readSheet(sheetName).filter(function (r) {
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
  const audits = env.sandbox.readSheet('AuditLog').filter(function (a) { return a.ACTION === 'CONTENT_SHEET_UPGRADE_V4'; });
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
  const audits = env.sandbox.readSheet('AuditLog').filter(function (a) { return a.ACTION === 'CONTENT_SHEET_UPGRADE_V4'; });
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
  const errs = env.sandbox.readSheet('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'CONTENT_SHEET_NEEDS_MIGRATION'; });
  assert.strictEqual(errs.length, 1, JSON.stringify(plain(env.sandbox.readSheet('ErrorLog'))));
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
  const audits = env.sandbox.readSheet('AuditLog').filter(function (a) { return a.ACTION === 'CONTENT_SHEET_UPGRADE_V4'; });
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
  const errs = env.sandbox.readSheet('ErrorLog').filter(function (e) { return e.ERROR_CODE === 'CONTENT_SHEET_LOCK_FAILED'; });
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
  assert.strictEqual(sb.readSheet('AuditLog').filter(function (a) { return a.ACTION === 'CONTENT_SHEET_NIGHTLY_SORT'; }).length, 1);
  // 排序之後再匯入，週報的先後與排序前相同。
  assert.strictEqual(sb.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  assert.deepStrictEqual(plainTexts(env, 'Announcements', D1), beforeD1);
  assert.deepStrictEqual(plainTexts(env, 'Announcements', D2), beforeD2);
  // 已經排好：再跑一次一格不寫、不記。
  const once = snapshot(env);
  sb.dailyQuarterAutoCreateTrigger_();
  assert.strictEqual(snapshot(env), once);
  assert.strictEqual(sb.readSheet('AuditLog').filter(function (a) { return a.ACTION === 'CONTENT_SHEET_NIGHTLY_SORT'; }).length, 1);
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
  const errs = sb.readSheet('ErrorLog').filter(function (e) { return e.FUNCTION_NAME === 'runNightlyContentSort_'; });
  assert.strictEqual(errs.length, 1, JSON.stringify(plain(sb.readSheet('ErrorLog'))));
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
