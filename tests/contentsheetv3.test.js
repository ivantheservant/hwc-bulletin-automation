#!/usr/bin/env node
/**
 * tests/contentsheetv3.test.js
 *
 * 內容表 v3（2026-10-26 Ivan 測試結果 A 第 10 項）：v2 內容表（凍結的 tests/fixtures/legacyContentSheetV2.js）
 * 更新成 v3——浸禮六欄（「崇拜程序」第 L 至 Q 欄）先搬入週報再刪欄；加「詩班項目名稱」並由週報回填；
 * 九欄與浸禮六欄的舊介面覆寫一律停用（九欄：內容表空白就把介面的值寫入內容表）。src/ContentSheetMigrateV3.gs。
 *
 * 一律經真正入口：`apiPreviewContentSheetBuild`／`apiRunContentSheetBuild`（填寫介面內容表狀態列的
 * 「更新本季內容表…」）、`apiLoadWeek`、`apiRunContentImport`、`weeklyBulletinSendTrigger_`。
 *
 * 執行方式：node tests/contentsheetv3.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const contentEnv = require('./helpers/contentEnv');
const { LEGACY_V2_WORSHIP_TAB_DEF } = require('./fixtures/legacyContentSheetV2');
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
 * 一個 v2 內容表（2026-10-23 部署之後各季就是這個樣子）與它的週報：
 *   - D1：崇拜程序有一行（浸禮主禮、受浸肢體）；週報浸禮兩格空白；週報有詩班項目名稱。
 *   - D2：崇拜程序有一行（講題空白）；講題有生效中的介面覆寫（內容表空白 → 覆寫值寫入內容表）。
 *   - D3：崇拜程序有一行（回應詩歌「內容表的詩」）；回應詩歌有覆寫「介面的詩」（不同 → 保留內容表，列出）。
 *   - D4：受浸肢體有覆寫（內容表另有值）→ 週報用覆寫值（印出來的值）。
 *   - D5：甚麼都沒有。
 */
function makeV2Env(extra) {
  const o = Object.assign({}, extra || {});
  return contentEnv.makeEnv(Object.assign({
    contentLayout: 'v2',
    // 2026-10-30（內容表 v4）：v2 → v3 之後再轉成 v4，v3 的「崇拜程序」改名保留；這裏驗的是 v3 那一張。
    keepOriginalTabRefs: true,
    weekRows: [
      { SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '講題甲', CHOIR_LABEL: '詩班獻詩' },
      { SERVICE_DATE: D2, QUARTER_ID: QUARTER_ID, SERMON_TITLE: '介面的講題' },
      { SERVICE_DATE: D3, QUARTER_ID: QUARTER_ID, RESPONSE_HYMN: '介面的詩' },
      { SERVICE_DATE: D4, QUARTER_ID: QUARTER_ID, BAPTISM_MEMBERS: '介面的名單' },
      { SERVICE_DATE: D5, QUARTER_ID: QUARTER_ID }
    ],
    content: {
      崇拜程序: [
        { SERVICE_DATE: D1, SERMON_TITLE: '講題甲', ACTIVE: 'TRUE', BAPTISM_OFFICIANT: '張牧師', BAPTISM_MEMBERS: '陳大文 李小明' },
        { SERVICE_DATE: D2, SERMON_TITLE: '', ACTIVE: 'TRUE' },
        { SERVICE_DATE: D3, RESPONSE_HYMN: '內容表的詩', ACTIVE: 'TRUE' },
        { SERVICE_DATE: D4, ACTIVE: 'TRUE', BAPTISM_MEMBERS: '內容表的名單' },
        { SERVICE_DATE: D5, ACTIVE: 'TRUE' }
      ]
    }
  }, o));
}

function seedOverrides(env) {
  env.sandbox.writeSheet('FieldOverride', [
    overrideRow(env, D2, 'SERMON_TITLE', '介面的講題', ''),
    overrideRow(env, D3, 'RESPONSE_HYMN', '介面的詩', '內容表舊的詩'),
    overrideRow(env, D4, 'BAPTISM_MEMBERS', '介面的名單', '內容表的名單')
  ]);
}

function overrideRow(env, iso, key, value, source) {
  return {
    SERVICE_DATE: env.sandbox.normalizeDate_(iso), FIELD_KEY: key, OVERRIDE_VALUE: value,
    SOURCE_VALUE_AT_OVERRIDE: source, OVERRIDE_AT: new Date(), OVERRIDE_BY: 'tester@x.com', REASON: '', ACTIVE: true, NOTES: ''
  };
}

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

function rowOf(env, iso) { return worshipRows(env).filter(function (r) { return String(r.SERVICE_DATE) === iso; })[0]; }

function weekOf(env, iso) {
  return env.sandbox.readSheet('BulletinWeeks').filter(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE) === iso; })[0];
}

function contentSnapshot(env) {
  return JSON.stringify(env.contentSpreadsheet.getSheets().map(function (s) {
    return { name: s.getName(), hidden: s.isSheetHidden(), data: s.__data };
  }));
}

function run(env) {
  const resp = env.sandbox.apiRunContentSheetBuild(QUARTER_ID);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  assert.strictEqual(resp.data.ok, true, JSON.stringify(resp.data));
  return resp.data;
}

console.log('\n內容表 v2 → v3');

test('V3-0 前提：凍結的 v2 定義與 src 的 contentSheetWorshipKeysV2_() 一字不差；v3 第 2 行是十二欄、沒有浸禮六欄', function () {
  const sb = makeV2Env().sandbox;
  assert.deepStrictEqual(plain(sb.contentSheetWorshipKeysV2_()), plain(LEGACY_V2_WORSHIP_TAB_DEF.keys));
  const v3 = plain(sb.contentSheetWorshipTabDefV3_().keys);
  assert.strictEqual(v3.length, 12);
  assert.strictEqual(v3[11], 'CHOIR_LABEL');
  sb.baptismBoxFieldKeys_().forEach(function (k) { assert.strictEqual(v3.indexOf(k), -1, k); });
});

test('V3-1 真入口 apiRunContentSheetBuild：浸禮六欄搬入週報（覆寫值優先，其餘用內容表的值）→ 第 L 至 Q 欄刪走 → 第 2 行等於 v3、詩班項目名稱由週報回填 → 舊覆寫全部停用（不刪行），內容表空白的格寫入介面的值', function () {
  const env = makeV2Env();
  seedOverrides(env);
  const data = run(env);

  // 第 1 步：浸禮六欄 → 週報
  assert.strictEqual(weekOf(env, D1).BAPTISM_OFFICIANT, '張牧師');
  assert.strictEqual(weekOf(env, D1).BAPTISM_MEMBERS, '陳大文 李小明', '多人欄位原樣');
  // D4：v2 的介面覆寫本來就同時寫入週報，所以週報已經是覆寫值，不用再寫；內容表的「內容表的名單」不可以蓋過它。
  assert.strictEqual(weekOf(env, D4).BAPTISM_MEMBERS, '介面的名單', '有覆寫就用覆寫值（那是印出來的值）');

  // 第 2 步：刪欄，第 2 行＝v3
  const tab = env.contentTabs['崇拜程序'];
  const v3 = plain(env.sandbox.contentSheetWorshipTabDefV3_().keys);
  assert.deepStrictEqual(plain(tab.__data[1].slice(0, v3.length)), v3, '第 2 行＝v3');
  assert.strictEqual(tab.getMaxColumns() >= v3.length, true);
  env.sandbox.baptismBoxFieldKeys_().forEach(function (k) {
    assert.strictEqual(tab.__data[1].indexOf(k), -1, k + ' 已刪走');
  });
  assert.strictEqual(rowOf(env, D1).SERMON_TITLE, '講題甲', '原有欄不動');
  assert.strictEqual(rowOf(env, D1).CHOIR_LABEL, '詩班獻詩', '詩班項目名稱由週報回填');

  // 第 3 步：覆寫
  assert.strictEqual(rowOf(env, D2).SERMON_TITLE, '介面的講題', '內容表空白 → 寫入介面的值（印出來的不變）');
  assert.strictEqual(rowOf(env, D3).RESPONSE_HYMN, '內容表的詩', '內容表有不同的值 → 保留內容表');
  const ov = env.sandbox.readSheet('FieldOverride');
  assert.strictEqual(ov.length, 3, '不刪行');
  assert.ok(ov.every(function (r) { return r.ACTIVE === false; }), '全部停用：' + JSON.stringify(plain(ov)));

  const audit = env.sandbox.readSheet('AuditLog');
  assert.strictEqual(audit.filter(function (r) { return r.ACTION === 'CONTENT_SHEET_UPGRADE_V3'; }).length, 2, '週報兩格逐格記錄（D1 兩格）');
  assert.strictEqual(audit.filter(function (r) { return r.ACTION === 'FIELD_OVERRIDE_RETIRE_V3'; }).length, 3);
  assert.ok(audit.some(function (r) { return r.ACTION === 'CONTENT_SHEET_MIGRATE_V3' && String(r.NEW_VALUE).indexOf('刪欄 6') === 0; }));

  const text = data.lines.join('\n');
  ['內容表更新成新版', '浸禮副框：已把 1 個主日共 2 格搬入週報', '整張已複製到隱藏分頁「崇拜程序（浸禮六欄，已停用）」', '然後已刪走這六欄',
    '以前在填寫介面改過的 3 格已停用', '1 格內容表是空白', '之後以內容表為準', '「回應詩歌」：介面「介面的詩」，內容表「內容表的詩」'
  ].forEach(function (piece) { assert.ok(text.indexOf(piece) !== -1, '結果缺少：' + piece + '\n' + text); });
  assertWrittenChinese(assert, 'v3 更新結果', data.lines);
});

test('V3-2 預覽（apiPreviewContentSheetBuild）唯讀，講的數字與實際一樣', function () {
  const env = makeV2Env();
  seedOverrides(env);
  const before = contentSnapshot(env);
  const weeksBefore = JSON.stringify(env.sandbox.readSheet('BulletinWeeks'));
  const preview = env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID);
  assert.strictEqual(preview.ok, true, JSON.stringify(preview));
  assert.strictEqual(preview.data.summary.needsMigration, true);
  assert.strictEqual(contentSnapshot(env), before, '預覽一格都不寫');
  assert.strictEqual(JSON.stringify(env.sandbox.readSheet('BulletinWeeks')), weeksBefore);
  const text = preview.data.lines.join('\n');
  ['浸禮副框：會把 1 個主日共 2 格搬入週報', '第 L 至 Q 欄（浸禮六欄）共 3 格有字', '然後會刪走這六欄', '以前在填寫介面改過的 3 格會停用'].forEach(function (piece) {
    assert.ok(text.indexOf(piece) !== -1, '預覽缺少：' + piece + '\n' + text);
  });
  const data = run(env);
  assert.ok(data.lines.join('\n').indexOf('已把 1 個主日共 2 格搬入週報') !== -1);
});

test('V3-3 冪等：做完再按一次，內容表與週報每一格相同，沒有新的 AuditLog（除了刷新版面的記錄）', function () {
  const env = makeV2Env();
  seedOverrides(env);
  run(env);
  const once = contentSnapshot(env);
  const weeks = JSON.stringify(env.sandbox.readSheet('BulletinWeeks').map(function (r) { const c = Object.assign({}, r); delete c.LAST_SAVED_AT; return c; }));
  const preview = env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID).data;
  assert.strictEqual(preview.summary.needsMigration, false, preview.lines.join('\n'));
  run(env);
  assert.strictEqual(contentSnapshot(env), once);
  assert.strictEqual(JSON.stringify(env.sandbox.readSheet('BulletinWeeks').map(function (r) { const c = Object.assign({}, r); delete c.LAST_SAVED_AT; return c; })), weeks);
});

test('V3-4 中途失敗（刪欄那一步）之後重跑：結果與一次做完相同；週報那幾格不會重複寫', function () {
  const env = makeV2Env({ contentFaults: { failOnDeleteColumns: 1 } });
  seedOverrides(env);
  const failed = env.sandbox.apiRunContentSheetBuild(QUARTER_ID);
  assert.ok(failed.ok === false || (failed.data && failed.data.ok === false), JSON.stringify(failed));
  assert.strictEqual(weekOf(env, D1).BAPTISM_OFFICIANT, '張牧師', '第 1 步已經做了');
  assert.strictEqual(env.sandbox.readSheet('FieldOverride').filter(function (r) { return r.ACTIVE === true; }).length, 3,
    '第 3 步未做：覆寫仍然生效（重跑時算出同一個值）');
  env.contentFaults.failOnDeleteColumns = null;
  run(env);
  const reference = makeV2Env();
  seedOverrides(reference);
  run(reference);
  assert.strictEqual(contentSnapshot(env), contentSnapshot(reference), '內容表與一次做完的一樣');
  assert.strictEqual(env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'CONTENT_SHEET_UPGRADE_V3'; }).length, 2,
    '週報兩格只寫一次');
});

test('V3-5 v2 第 17 欄之後（刪欄之後變成「詩班項目名稱」）原本有字 → 預覽與執行都整次拒絕，一格都不寫（包括週報、覆寫）', function () {
  const env = makeV2Env();
  seedOverrides(env);
  const tab = env.contentTabs['崇拜程序'];
  while (tab.__data[2].length < 18) tab.__data[2].push('');
  tab.__data[2][17] = '人手備忘';
  const before = contentSnapshot(env);
  const weeksBefore = JSON.stringify(env.sandbox.readSheet('BulletinWeeks'));
  assert.strictEqual(env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID).data.reason, 'NEW_COLUMNS_NOT_EMPTY');
  const resp = env.sandbox.apiRunContentSheetBuild(QUARTER_ID);
  assert.strictEqual(resp.data.reason, 'NEW_COLUMNS_NOT_EMPTY', JSON.stringify(resp));
  assert.strictEqual(contentSnapshot(env), before);
  assert.strictEqual(JSON.stringify(env.sandbox.readSheet('BulletinWeeks')), weeksBefore);
  assert.strictEqual(env.sandbox.readSheet('FieldOverride').filter(function (r) { return r.ACTIVE === true; }).length, 3);
});

test('V3-6 更新之前：匯入（apiRunContentImport）整次拒絕並講出要按「更新本季內容表…」；apiLoadWeek 的內容表狀態是 OUTDATED；更新之後照常匯入', function () {
  const env = makeV2Env();
  const resp = env.sandbox.apiRunContentImport(D1);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  assert.strictEqual(resp.data.ok, false);
  assert.strictEqual(resp.data.reason, 'CONTENT_SHEET_OUTDATED');
  assert.ok(resp.data.message.indexOf('仍然有浸禮六欄') !== -1 && resp.data.message.indexOf('更新本季內容表…') !== -1, resp.data.message);
  const load = env.sandbox.apiLoadWeek(D1);
  assert.strictEqual(load.ok, true, JSON.stringify(load.error));
  assert.strictEqual(load.data.contentSheet.schemaStatus, 'OUTDATED');
  run(env);
  const after = env.sandbox.apiRunContentImport(D1);
  assert.strictEqual(after.data.ok, true, JSON.stringify(after.data));
  assert.strictEqual(env.sandbox.apiLoadWeek(D1).data.contentSheet.schemaStatus, 'OK');
  assertWrittenChinese(assert, '內容表比系統舊', [resp.data.message]);
});

test('V3-7 星期一自動流程（weeklyBulletinSendTrigger_）遇到 v2 內容表 → 略過，一格不寫，ErrorLog 留一筆 CONTENT_SHEET_NEEDS_MIGRATION', function () {
  const env = makeV2Env({ config: { CONTENT_SHEET_INVITE_LEAD_DAYS: '100000', DRY_RUN: 'TRUE' } });
  const before = contentSnapshot(env);
  env.sandbox.weeklyBulletinSendTrigger_();
  assert.strictEqual(contentSnapshot(env), before);
  const errs = env.sandbox.readSheet('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'CONTENT_SHEET_NEEDS_MIGRATION'; });
  assert.strictEqual(errs.length, 1, JSON.stringify(env.sandbox.readSheet('ErrorLog').map(function (r) { return r.ERROR_CODE + ' ' + r.MESSAGE; })));
});

test('V3-8 版本記錄：搬入週報之前替受影響的主日各存一個「更新內容表之前」版本', function () {
  const env = makeV2Env();
  seedOverrides(env);
  run(env);
  const snaps = env.sandbox.readSheet('WeekSnapshots').filter(function (r) { return r.REASON === 'CONTENT_SHEET_UPGRADE'; });
  const dates = Array.from(new Set(snaps.map(function (r) { return env.sandbox.formatIsoDate_(r.SERVICE_DATE); }))).sort();
  assert.deepStrictEqual(dates, [D1], '只有真的改到週報的主日（D4 週報已經是覆寫值）');
});

// 獨立審查（2026-10-26）：第 1 步只搬「這一季、週報有那一行、最後一行生效中」的值；刪欄之前沒有備份的話，
// 其餘有字的格（季度以外、同一主日的舊行、停用的行、週報未有那一行的主日）會連同那六欄一齊消失，而預覽還講
// 「內容表保留原值」。改為刪欄之前整張「崇拜程序」複製到隱藏分頁。
test('V3-9 刪走浸禮六欄之前整張備份：季度以外、同一主日的舊行、停用的行、週報未有那一行的主日，浸禮資料一格都不會丟；預覽與結果講明', function () {
  const BACKUP = '崇拜程序（浸禮六欄，已停用）';
  const env = contentEnv.makeEnv({
    contentLayout: 'v2',
    keepOriginalTabRefs: true,
    weekRows: [D1, D2, D3, D4].map(function (iso) { return { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID }; }),
    content: {
      崇拜程序: [
        { SERVICE_DATE: '2027-09-26', ACTIVE: 'TRUE', BAPTISM_OFFICIANT: '域外牧師' },
        { SERVICE_DATE: D1, ACTIVE: 'TRUE', BAPTISM_OFFICIANT: '第一行牧師' },
        { SERVICE_DATE: D1, ACTIVE: 'TRUE', BAPTISM_OFFICIANT: '最後一行牧師' },
        { SERVICE_DATE: D2, ACTIVE: 'FALSE', BAPTISM_MEMBERS: '停用行名單' },
        { SERVICE_DATE: D5, ACTIVE: 'TRUE', BAPTISM_OFFICIANT: '未有週報的牧師' }
      ]
    }
  });
  const preview = env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID);
  assert.strictEqual(preview.ok, true, JSON.stringify(preview));
  const pl = preview.data.lines.join('\n');
  assert.ok(pl.indexOf('共 5 格有字') !== -1 && pl.indexOf('會複製到隱藏分頁「' + BACKUP + '」') !== -1, pl);
  assert.ok(pl.indexOf('保留在備份分頁') !== -1, pl);
  assert.strictEqual(pl.indexOf('內容表保留原值'), -1, 'v2 會刪欄，不可以講「內容表保留原值」');
  assert.strictEqual(env.contentTabs[BACKUP], undefined, '預覽唯讀');

  const data = run(env);
  const backup = env.contentTabs[BACKUP];
  assert.ok(backup, '要有備份分頁');
  const flat = JSON.stringify(backup.__data);
  ['域外牧師', '第一行牧師', '最後一行牧師', '停用行名單', '未有週報的牧師'].forEach(function (v) {
    assert.ok(flat.indexOf(v) !== -1, v + ' 要在備份分頁');
  });
  assert.deepStrictEqual(plain(backup.__data[1]).slice(0, LEGACY_V2_WORSHIP_TAB_DEF.keys.length), LEGACY_V2_WORSHIP_TAB_DEF.keys, '連第 2 行機器鍵一齊備份');
  assert.strictEqual(backup.isSheetHidden(), true);
  assert.ok(String(backup.getRange(1, 1, 1, 1).getNote()).indexOf('已停用（2026-10-26）') === 0);
  assert.strictEqual(weekOf(env, D1).BAPTISM_OFFICIANT, '最後一行牧師', '這一季、週報有那一行的主日照樣搬入週報');
  assert.strictEqual(JSON.stringify(env.contentTabs['崇拜程序'].__data).indexOf('牧師'), -1, '崇拜程序已經沒有浸禮六欄');
  const lines = data.lines.join('\n');
  assert.ok(lines.indexOf('已複製到隱藏分頁「' + BACKUP + '」') !== -1, lines);
  assert.ok(env.sandbox.readSheet('AuditLog').some(function (r) { return String(r.NEW_VALUE).indexOf('備份') === 0; }));
  assertWrittenChinese(assert, 'V3-9', [pl, lines]);

  // 再按一次：已經是 v3，不再備份、不再刪欄；備份分頁原封不動。
  const before = JSON.stringify(backup.__data);
  run(env);
  assert.strictEqual(JSON.stringify(env.contentTabs[BACKUP].__data), before);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
