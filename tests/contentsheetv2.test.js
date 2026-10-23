#!/usr/bin/env node
/**
 * tests/contentsheetv2.test.js
 *
 * 內容表 v2：v1 內容表（凍結的 tests/fixtures/legacyContentSheetV1.js）移轉成 v2——「宣召」「浸禮合堂」
 * 併入「崇拜程序」，新欄只加在最後，舊分頁改名、隱藏、不刪（src/ContentSheetMigrate.gs）。
 *
 * 一律經真正入口：`apiPreviewContentSheetBuild`／`apiRunContentSheetBuild`（填寫介面「季度作業」）、
 * `menuCreateContentSheet_`（選單，UI 替身答「是／否」）、`weeklyBulletinSendTrigger_`（星期一自動流程）、
 * `apiRunQuarterContentImport`（移轉之後整季匯入）。新建內容表（M11）在 tests/contentsheet.test.js。
 *
 * 執行方式：node tests/contentsheetv2.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const contentEnv = require('./helpers/contentEnv');
const { legacyContentTabDefV1 } = require('./fixtures/legacyContentSheetV1');
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
    console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err));
  }
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

/**
 * 一個「真的是 v1」的內容表（2027T4、2028T2 現時就是這個樣子），加上與它同步的週報（之前匯入過）。
 *   - D1：崇拜程序有一行；宣召有一行；週報有序樂、詩歌頌讚；
 *   - D2：崇拜程序有一行；宣召、浸禮合堂各有一行；
 *   - D3：崇拜程序沒有行；週報有講題、序樂（以前在填寫介面填的）；
 *   - D4：只有舊宣召有一行；
 *   - D5：甚麼都沒有。
 */
function baseOptions(extra) {
  const o = Object.assign({}, extra || {});
  const content = Object.assign({
    崇拜程序: [
      { SERVICE_DATE: D1, SCRIPTURE_REF: '約翰福音 3:16', SERMON_TITLE: '講題甲', ACTIVE: 'TRUE' },
      { SERVICE_DATE: D2, SERMON_TITLE: '講題乙', ACTIVE: 'TRUE' }
    ],
    宣召: [
      { SERVICE_DATE: D1, CALL_REF: '詩篇 100:1', CALL_TEXT: '經文甲', ACTIVE: 'TRUE' },
      { SERVICE_DATE: D2, CALL_REF: '詩篇 23:1', CALL_TEXT: '經文乙', ACTIVE: 'TRUE' },
      { SERVICE_DATE: D4, CALL_REF: '詩篇 1:1', CALL_TEXT: '經文丁', ACTIVE: 'TRUE' }
    ],
    浸禮合堂: [
      { SERVICE_DATE: D2, BAPTISM_OFFICIANT: '張牧師', BAPTISM_MEMBERS: '陳大文 李小明', ACTIVE: 'TRUE' }
    ]
  }, o.content || {});
  delete o.content;
  (o.omitTabs || []).forEach(function (name) { delete content[name]; });
  return Object.assign({
    contentLayout: 'v1',
    weekRows: [
      { SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, PRELUDE: '序樂甲', CALL_REF: '詩篇 100:1', CALL_TEXT: '經文甲', HYMN_PRAISE: '詩歌甲', SCRIPTURE_REF: '約翰福音 3:16', SERMON_TITLE: '講題甲' },
      { SERVICE_DATE: D2, QUARTER_ID: QUARTER_ID, PRELUDE: '序樂乙', CALL_REF: '詩篇 23:1', CALL_TEXT: '經文乙', SERMON_TITLE: '講題乙', BAPTISM_OFFICIANT: '張牧師', BAPTISM_MEMBERS: '陳大文 李小明' },
      { SERVICE_DATE: D3, QUARTER_ID: QUARTER_ID, PRELUDE: '序樂丙', SERMON_TITLE: '講題丙' },
      { SERVICE_DATE: D4, QUARTER_ID: QUARTER_ID, CALL_REF: '詩篇 1:1', CALL_TEXT: '經文丁' },
      { SERVICE_DATE: D5, QUARTER_ID: QUARTER_ID }
    ],
    content: content
  }, o);
}

function makeV1Env(extra) {
  return contentEnv.makeEnv(baseOptions(extra));
}

/** 讀「崇拜程序」分頁：按第 2 行（現時的機器鍵）把第 3 行起每一行轉成物件。 */
function worshipRows(env) {
  const data = env.contentTabs['崇拜程序'].__data;
  const keys = data[1];
  return plain(data.slice(2).filter(function (r) { return r.some(function (v) { return v !== '' && v !== null && v !== undefined; }); })
    .map(function (r) {
      const o = {};
      keys.forEach(function (k, i) { if (k) o[k] = r[i] === undefined ? '' : r[i]; });
      return o;
    }));
}

function rowOf(env, iso) {
  return worshipRows(env).filter(function (r) { return String(r.SERVICE_DATE) === iso; });
}

function weekOf(env, iso) {
  return env.sandbox.readSheet('BulletinWeeks').filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === iso; })[0];
}

/** 內容表全部分頁的名稱、隱藏與否、資料（比較「兩次結果完全相同」用）。 */
function contentSnapshot(env) {
  return JSON.stringify(env.contentSpreadsheet.getSheets().map(function (s) {
    return { name: s.getName(), hidden: s.isSheetHidden(), data: s.__data };
  }));
}

function v2Keys(env) { return plain(env.sandbox.contentSheetWorshipTabDef_().keys); }

function run(env) {
  const resp = env.sandbox.apiRunContentSheetBuild(QUARTER_ID);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  return resp.data;
}

// =====================================================================

console.log('\n移轉');

test('M1 v1 → v2（真入口 apiRunContentSheetBuild）：第 2 行等於 v2；宣召、浸禮搬入對的行與欄；只有舊分頁或週報有的主日新增一行並帶齊週報；舊分頁改名、隱藏、有註解、警告式保護、沒有刪；檔案 ID 不變', function () {
  const env = makeV1Env();
  const fileIdBefore = env.sandbox.readSheet('ContentSheets')[0].FILE_ID;
  const callBefore = JSON.stringify(env.contentTabs['宣召'].__data);
  const data = run(env);
  assert.strictEqual(data.ok, true, JSON.stringify(data));

  assert.deepStrictEqual(plain(env.contentTabs['崇拜程序'].__data[1].slice(0, v2Keys(env).length)), v2Keys(env), '第 2 行＝v2');
  const d1 = rowOf(env, D1);
  assert.strictEqual(d1.length, 1);
  assert.strictEqual(d1[0].SCRIPTURE_REF, '約翰福音 3:16', '原有欄不動');
  assert.strictEqual(d1[0].CALL_REF, '詩篇 100:1');
  assert.strictEqual(d1[0].CALL_TEXT, '經文甲');
  assert.strictEqual(d1[0].PRELUDE, '序樂甲', '新欄由週報回填');
  assert.strictEqual(d1[0].HYMN_PRAISE, '詩歌甲');
  const d2 = rowOf(env, D2)[0];
  assert.strictEqual(d2.BAPTISM_OFFICIANT, '張牧師');
  assert.strictEqual(d2.BAPTISM_MEMBERS, '陳大文 李小明');
  assert.strictEqual(d2.CALL_TEXT, '經文乙');
  const d3 = rowOf(env, D3);
  assert.strictEqual(d3.length, 1, '崇拜程序沒有行的主日新增一行');
  assert.strictEqual(d3[0].SERMON_TITLE, '講題丙', '新增的行所有欄由週報帶齊（否則匯入會清空講題）');
  assert.strictEqual(d3[0].PRELUDE, '序樂丙');
  assert.strictEqual(String(d3[0].ACTIVE).toUpperCase(), 'TRUE');
  assert.strictEqual(d3[0].NOTES, '系統移轉建立');
  assert.strictEqual(rowOf(env, D4)[0].CALL_REF, '詩篇 1:1', '只有舊宣召才有的主日亦新增一行');
  assert.strictEqual(rowOf(env, D5).length, 1, '每個主日一行');

  const ss = env.contentSpreadsheet;
  assert.strictEqual(ss.getSheetByName('宣召'), null);
  const retired = ss.getSheetByName('宣召（已停用）');
  assert.ok(retired, '改名不刪');
  assert.strictEqual(JSON.stringify(retired.__data), callBefore, '舊分頁的資料原封不動');
  assert.strictEqual(retired.isSheetHidden(), true);
  assert.ok(retired.getRange(1, 1).getNote().indexOf('已停用') !== -1);
  assert.ok(retired.__protections.length === 1 && retired.__protections[0].warningOnly === true, '警告式保護');
  assert.ok(ss.getSheetByName('浸禮合堂（已停用）'));
  assert.strictEqual(env.sandbox.readSheet('ContentSheets')[0].FILE_ID, fileIdBefore);
  assert.strictEqual(env.sandbox.readSheet('ContentSheets').length, 1);

  const audit = env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'CONTENT_SHEET_MIGRATE_V2'; });
  assert.strictEqual(audit.length, 3, '崇拜程序一行、兩張舊分頁各一行');
  const text = data.lines.join('\n');
  ['內容表移轉成新版', '由舊「宣召」搬入 3 個主日', '由舊「浸禮合堂」搬入 1 個主日', '新增 3 行'].forEach(function (piece) {
    assert.ok(text.indexOf(piece) !== -1, '結果缺少：' + piece + '\n' + text);
  });
  assertWrittenChinese(assert, '移轉結果', data.lines);
});

test('M2 冪等：跑兩次，內容表每一格相同；第二次預覽講「已經是新版，沒有需要移轉」', function () {
  const env = makeV1Env();
  run(env);
  const once = contentSnapshot(env);
  const preview = env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID).data;
  assert.ok(preview.lines.join('\n').indexOf('已經是新版，沒有需要移轉') !== -1, preview.lines.join('\n'));
  assert.strictEqual(preview.summary.needsMigration, false);
  assert.strictEqual(preview.summary.migration, null, '第二次沒有東西要寫');
  run(env);
  assert.strictEqual(contentSnapshot(env), once);
});

test('M3 崇拜程序已經有不同的宣召 → 不蓋，結果列出「兩邊不同」', function () {
  const env = makeV1Env({ content: { 崇拜程序: [
    { SERVICE_DATE: D1, SERMON_TITLE: '講題甲', ACTIVE: 'TRUE' },
    { SERVICE_DATE: D2, SERMON_TITLE: '講題乙', ACTIVE: 'TRUE' }
  ] } });
  // 崇拜程序第 8 欄起本來沒有標題；有人在那裏打了字（v1 的第 9 欄＝v2 的 CALL_REF）。
  const tab = env.contentTabs['崇拜程序'];
  const col = v2Keys(env).indexOf('CALL_REF');
  tab.__data[2][col] = '人手填的出處';
  const data = run(env);
  assert.strictEqual(rowOf(env, D1)[0].CALL_REF, '人手填的出處', '已經有值的格不蓋');
  assert.strictEqual(rowOf(env, D1)[0].CALL_TEXT, '經文甲', '同一行的空白格照填');
  const text = data.lines.join('\n');
  assert.ok(text.indexOf('1 格兩邊不同，保留「崇拜程序」的值') !== -1, text);
  assert.ok(text.indexOf('「宣召出處」：崇拜程序「人手填的出處」，舊宣召「詩篇 100:1」') !== -1, text);
});

test('M4 週報回填只填新欄的空白格；原有欄（讀經經文、講題等）以內容表為準，不回填亦不報不同', function () {
  const env = makeV1Env({
    weekRows: [{ SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '週報的講題', SCRIPTURE_REF: '週報的經文', PRELUDE: '序樂甲' }],
    content: { 崇拜程序: [{ SERVICE_DATE: D1, SERMON_TITLE: '內容表的講題', ACTIVE: 'TRUE' }], 宣召: [], 浸禮合堂: [] }
  });
  const data = run(env);
  const d1 = rowOf(env, D1)[0];
  assert.strictEqual(d1.SERMON_TITLE, '內容表的講題');
  assert.strictEqual(d1.SCRIPTURE_REF, '', '原有欄空白也不由週報回填（以內容表為準）');
  assert.strictEqual(d1.PRELUDE, '序樂甲');
  assert.strictEqual(data.lines.join('\n').indexOf('兩邊不同'), -1);
});

test('M5 移轉之後經真入口 apiRunQuarterContentImport 整季匯入 → 週報一格不變（移轉欄位 0 改動）', function () {
  const env = makeV1Env();
  run(env);
  const before = JSON.stringify(env.sandbox.readSheet('BulletinWeeks'));
  const preview = env.sandbox.apiPreviewQuarterContentImport(QUARTER_ID);
  assert.strictEqual(preview.data.ok, true, JSON.stringify(preview));
  const resp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(resp.data.ok, true, JSON.stringify(resp));
  assert.strictEqual(JSON.stringify(env.sandbox.readSheet('BulletinWeeks')), before);
  assert.strictEqual(env.sandbox.readSheet('AuditLog').filter(function (r) {
    return r.ACTION === 'CONTENT_SHEET_IMPORT' && r.SHEET_NAME === 'BulletinWeeks';
  }).length, 0, '一格都沒有寫');
});

test('M6 移轉中途失敗（第 3 次寫格、第 1 次改名）→ 匯入被擋 → 重跑 → 結果與一次跑完完全相同', function () {
  const clean = makeV1Env();
  run(clean);
  const expected = contentSnapshot(clean);

  [{ failOnSetValue: 3 }, { failOnSetName: 1 }].forEach(function (fault) {
    const env = makeV1Env({ contentFaults: fault });
    const failed = env.sandbox.apiRunContentSheetBuild(QUARTER_ID);
    assert.strictEqual(failed.ok, false, JSON.stringify(fault) + '：要失敗');
    const blocked = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
    assert.strictEqual(blocked.data.reason, 'CONTENT_SHEET_OUTDATED', JSON.stringify(fault) + '：' + JSON.stringify(blocked));
    env.contentFaults.failOnSetValue = null;
    env.contentFaults.failOnSetName = null;
    run(env);
    assert.strictEqual(contentSnapshot(env), expected, JSON.stringify(fault) + '：重跑之後要與一次跑完相同');
  });
});

test('M6b 舊分頁已改名、第 2 行未寫（改名之後失敗）→ 重跑由「宣召（已停用）」照樣搬', function () {
  const callDef = legacyContentTabDefV1('宣召');
  const env = makeV1Env({
    omitTabs: ['宣召'],
    extraTabs: [{ tabName: '宣召（已停用）', keys: callDef.keys, headers: callDef.headers,
      rows: [{ SERVICE_DATE: D1, CALL_REF: '詩篇 100:1', CALL_TEXT: '經文甲', ACTIVE: 'TRUE' }] }]
  });
  run(env);
  assert.strictEqual(rowOf(env, D1)[0].CALL_TEXT, '經文甲');
  assert.ok(env.contentSpreadsheet.getSheetByName('宣召（已停用）'), '已改名的不會再改名');
  assert.strictEqual(env.contentSpreadsheet.getSheetByName('宣召（已停用）2'), null);
});

test('M7 舊分頁的停用行、跨季日期、同一主日多行生效 → 不搬（多行以最後一行為準），結果逐項列出', function () {
  const env = makeV1Env({ content: { 宣召: [
    { SERVICE_DATE: D1, CALL_REF: '先寫的', CALL_TEXT: '先', ACTIVE: 'TRUE' },
    { SERVICE_DATE: D1, CALL_REF: '後寫的', CALL_TEXT: '後', ACTIVE: 'TRUE' },
    { SERVICE_DATE: D2, CALL_REF: '停用的', CALL_TEXT: '停', ACTIVE: 'FALSE' },
    { SERVICE_DATE: '2026-01-04', CALL_REF: '別季的', CALL_TEXT: '別', ACTIVE: 'TRUE' }
  ] }, weekRows: [{ SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID }, { SERVICE_DATE: D2, QUARTER_ID: QUARTER_ID }] });
  const data = run(env);
  assert.strictEqual(rowOf(env, D1)[0].CALL_REF, '後寫的', '以最後一行生效中的為準（與匯入同一行）');
  assert.strictEqual(rowOf(env, D2)[0].CALL_REF, '', '停用的不搬');
  const text = data.lines.join('\n');
  ['同一個主日有多行生效中的資料', '已停用（有效＝FALSE），沒有搬', '不是本季的主日，沒有搬', '3 項沒有搬'].forEach(function (piece) {
    assert.ok(text.indexOf(piece) !== -1, '缺少：' + piece + '\n' + text);
  });
});

test('M8 「崇拜程序」或舊分頁的第 2 行被改過 → 認不出，一格都不寫、不改名', function () {
  [['崇拜程序', 2, 'SERMON_TITLE', 'LAYOUT_UNKNOWN'], ['浸禮合堂', 2, '亂改的', 'LEGACY_LAYOUT_UNKNOWN']].forEach(function (c) {
    const env = makeV1Env();
    env.contentTabs[c[0]].__data[1][c[1] - 1] = c[2];
    const before = contentSnapshot(env);
    const resp = env.sandbox.apiRunContentSheetBuild(QUARTER_ID);
    assert.strictEqual(resp.data.ok, false);
    assert.strictEqual(resp.data.reason, c[3]);
    assert.strictEqual(contentSnapshot(env), before, c[0] + '：一格都不可以寫');
    assert.ok(resp.data.message.indexOf('一格都沒有寫') !== -1, resp.data.message);
    const preview = env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID).data;
    assert.strictEqual(preview.reason, c[3], '預覽一樣講出來');
  });
});

test('M9 星期一自動流程（weeklyBulletinSendTrigger_）遇到要移轉的內容表 → 略過，一格不寫，ErrorLog 留一筆 CONTENT_SHEET_NEEDS_MIGRATION', function () {
  const env = makeV1Env({ config: { CONTENT_SHEET_INVITE_LEAD_DAYS: '100000', DRY_RUN: 'TRUE' } });
  const before = contentSnapshot(env);
  env.sandbox.weeklyBulletinSendTrigger_();
  assert.strictEqual(contentSnapshot(env), before);
  const errs = env.sandbox.readSheet('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'CONTENT_SHEET_NEEDS_MIGRATION'; });
  assert.strictEqual(errs.length, 1, JSON.stringify(env.sandbox.readSheet('ErrorLog').map(function (r) { return r.ERROR_CODE + ' ' + r.MESSAGE; })));
  assert.ok(errs[0].MESSAGE.indexOf('建立／刷新本季內容表') !== -1, errs[0].MESSAGE);
});

test('M10 預覽（apiPreviewContentSheetBuild）的數字等於實際（apiRunContentSheetBuild）', function () {
  const env = makeV1Env();
  const preview = env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID).data;
  assert.strictEqual(preview.summary.needsMigration, true);
  const text = preview.lines.join('\n');
  ['「崇拜程序」會在最後加 10 欄', '由週報回填', '舊分頁「宣召」「浸禮合堂」會改名', '不會刪除'].forEach(function (piece) {
    assert.ok(text.indexOf(piece) !== -1, '預覽缺少：' + piece + '\n' + text);
  });
  assertWrittenChinese(assert, '移轉預覽', preview.lines);
  const data = run(env);
  assert.deepStrictEqual(plain(data.summary.migration), plain(preview.summary.migration));
});

test('M10b 選單「建立本季內容表」：先預覽、答「否」一格不寫；答「是」才移轉（與季度作業同一份預覽）', function () {
  const no = makeV1Env({ uiConfirm: 'NO' });
  const before = contentSnapshot(no);
  no.sandbox.menuCreateContentSheet_();
  assert.strictEqual(contentSnapshot(no), before);
  assert.ok(no.uiAlerts[0].body.indexOf('內容表移轉成新版') !== -1, no.uiAlerts[0].body);

  const yes = makeV1Env({ uiConfirm: 'YES' });
  yes.sandbox.menuCreateContentSheet_();
  assert.strictEqual(rowOf(yes, D1)[0].CALL_REF, '詩篇 100:1');
});

test('M12 拿不到指令碼鎖 → 拋 LOCK_TIMEOUT，一格不寫（兩個分頁同時按不會重複新增行）', function () {
  const env = makeV1Env({ lockFails: true });
  const before = contentSnapshot(env);
  const resp = env.sandbox.apiRunContentSheetBuild(QUARTER_ID);
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'LOCK_TIMEOUT');
  assert.strictEqual(contentSnapshot(env), before);
});

test('匯入：移轉之前（v1 內容表）匯入被擋；未改名的舊分頁仍然在亦被擋', function () {
  const env = makeV1Env();
  const resp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(resp.data.reason, 'CONTENT_SHEET_OUTDATED');
  assert.ok(resp.data.message.indexOf('仍然有舊的「宣召」分頁') !== -1, resp.data.message);
  run(env);
  // 有人之後再開一張叫「宣召」的分頁（例如由舊範本抄過來）。
  const callDef = legacyContentTabDefV1('宣召');
  const again = contentEnv.makeEnv({
    extraTabs: [{ tabName: '宣召', keys: callDef.keys, headers: callDef.headers, rows: [] }]
  });
  assert.strictEqual(again.sandbox.apiRunQuarterContentImport(QUARTER_ID).data.reason, 'CONTENT_SHEET_OUTDATED');
});

test('序樂空白時週報印 Config PRELUDE_DEFAULT（決定 11）；工作表那一格仍然是空白', function () {
  const env = makeV1Env({ config: { PRELUDE_DEFAULT: '預設序樂' } });
  run(env);
  const tab = env.contentTabs['崇拜程序'];
  const col = v2Keys(env).indexOf('PRELUDE');
  tab.__data[2][col] = '';
  env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(weekOf(env, D1).PRELUDE, '', '序樂跟隨內容表（空白）');
  assert.strictEqual(env.sandbox.buildBulletinModel_(D1).weekFields.PRELUDE, '預設序樂');
  assert.strictEqual(env.sandbox.applyPreludeDefault_({ PRELUDE: '自己的' }, '預設序樂').PRELUDE, '自己的');
  assert.strictEqual(env.sandbox.applyPreludeDefault_({}, '預設序樂').PRELUDE, undefined, '沒有那一行就不憑空造');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
