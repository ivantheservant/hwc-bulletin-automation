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
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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

test('M3（審查 A6，HH-14 改）v1 新欄位置原本有人打過字 → 整次拒絕（NEW_COLUMNS_NOT_EMPTY），逐格列出，一格都不寫、不改名；清走之後再按就移轉', function () {
  const env = makeV1Env({ content: { 崇拜程序: [
    { SERVICE_DATE: D1, SERMON_TITLE: '講題甲', ACTIVE: 'TRUE' },
    { SERVICE_DATE: D2, SERMON_TITLE: '講題乙', ACTIVE: 'TRUE' }
  ] } });
  // 崇拜程序第 8 欄起本來沒有標題；有人在那裏打了字（v1 的第 9 欄＝v2 的 CALL_REF）。
  const tab = env.contentTabs['崇拜程序'];
  const col = v2Keys(env).indexOf('CALL_REF');
  tab.__data[2][col] = '人手填的出處';
  const before = contentSnapshot(env);

  const preview = env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID);
  assert.strictEqual(preview.data.ok, false, JSON.stringify(preview));
  assert.strictEqual(preview.data.reason, 'NEW_COLUMNS_NOT_EMPTY');
  const resp = env.sandbox.apiRunContentSheetBuild(QUARTER_ID);
  const data = resp.data || {};
  assert.strictEqual(data.ok, false, JSON.stringify(resp));
  assert.strictEqual(data.reason, 'NEW_COLUMNS_NOT_EMPTY');
  const message = String(data.message || (data.lines || []).join('\n'));
  assert.ok(message.indexOf('I3（' + D1 + '，新欄「宣召出處」的位置）：「人手填的出處」') !== -1, message);
  assert.ok(message.indexOf('一格都沒有寫') !== -1 && message.indexOf('「備註」') !== -1, message);
  assertWrittenChinese(assert, '新欄位置有字', message);
  assert.strictEqual(contentSnapshot(env), before, '一格都不寫、不改名');

  // 清走之後再按：照常移轉，那一格由舊宣召填上。
  tab.__data[2][col] = '';
  run(env);
  assert.strictEqual(rowOf(env, D1)[0].CALL_REF, '詩篇 100:1');
});

test('M3b（審查 A6）週報那一格空白、新欄位置有字（之前預覽一句都不提，之後匯入當成浸禮主禮）→ 同樣整次拒絕；停用行、同一主日較早那一行的新欄位置有字亦拒絕', function () {
  const env = makeV1Env();
  const tab = env.contentTabs['崇拜程序'];
  const col = v2Keys(env).indexOf('BAPTISM_OFFICIANT');
  while (tab.__data[2].length <= col) tab.__data[2].push('');
  tab.__data[2][col] = '備忘：問牧師';
  const resp = env.sandbox.apiRunContentSheetBuild(QUARTER_ID);
  assert.strictEqual(resp.data.reason, 'NEW_COLUMNS_NOT_EMPTY', JSON.stringify(resp));
  assert.strictEqual(weekOf(env, D1).BAPTISM_OFFICIANT || '', '', '週報沒有被改');

  const env2 = makeV1Env({ content: { 崇拜程序: [
    { SERVICE_DATE: D1, SERMON_TITLE: '舊的', ACTIVE: 'FALSE' },
    { SERVICE_DATE: D1, SERMON_TITLE: '講題甲', ACTIVE: 'TRUE' }
  ] } });
  const tab2 = env2.contentTabs['崇拜程序'];
  const col2 = v2Keys(env2).indexOf('PRELUDE');
  while (tab2.__data[2].length <= col2) tab2.__data[2].push('');
  tab2.__data[2][col2] = '停用行上的字';
  assert.strictEqual(env2.sandbox.apiRunContentSheetBuild(QUARTER_ID).data.reason, 'NEW_COLUMNS_NOT_EMPTY');
});

test('M3c（審查 A6）中途失敗之後重跑：新欄已經由移轉寫好的格（與計畫的值相同）、移轉新增的行，不算「原本有字」', function () {
  // 新增行之後才失敗（改名那一步）：目標行的新欄、新增的行都已經寫好。
  const env = makeV1Env({ contentFaults: { failOnSetName: 1 } });
  assert.strictEqual(env.sandbox.apiRunContentSheetBuild(QUARTER_ID).ok, false);
  env.contentFaults.failOnSetName = null;
  // 移轉新增的行（備註「系統移轉建立」）：週報之後改了，那一行新欄的值與週報不同 → 照舊當作兩邊不同，不拒絕。
  env.sandbox.writeBulletinWeekField_(D3, 'PRELUDE', '週報後來改的序樂');
  const data = run(env);
  assert.strictEqual(rowOf(env, D3)[0].PRELUDE, '序樂丙', '保留移轉新增那一行的值');
  assert.ok(data.lines.join('\n').indexOf('兩邊不同') !== -1, data.lines.join('\n'));
  assert.strictEqual(rowOf(env, D1)[0].CALL_TEXT, '經文甲', '目標行上一次已寫好的新欄不算原本有字');
});

test('M3d（審查 A3）只有停用行的主日：不另開一行；新欄回填在最後一行停用行；之後把它改回 TRUE 再整季匯入，序樂、宣召、詩歌頌讚不會被清空', function () {
  const env = makeV1Env({ content: { 崇拜程序: [
    { SERVICE_DATE: D1, SCRIPTURE_REF: '約翰福音 3:16', SERMON_TITLE: '講題甲', ACTIVE: 'FALSE' }
  ] } });
  const data = run(env);
  const d1 = rowOf(env, D1);
  assert.strictEqual(d1.length, 1, '不另開一行');
  assert.strictEqual(String(d1[0].ACTIVE), 'FALSE', '仍然停用');
  assert.strictEqual(d1[0].PRELUDE, '序樂甲');
  assert.strictEqual(d1[0].HYMN_PRAISE, '詩歌甲');
  assert.strictEqual(d1[0].CALL_REF, '詩篇 100:1', '舊宣召的值亦填在停用行');
  assert.strictEqual(d1[0].CALL_TEXT, '經文甲');
  const text = data.lines.join('\n');
  assert.ok(text.indexOf('1 個主日在「崇拜程序」只有已停用的行') !== -1, text);

  // 幹事把那一行改回 TRUE，整季匯入：週報的序樂、宣召、詩歌頌讚不變。
  const tab = env.contentTabs['崇拜程序'];
  const keys = tab.__data[1];
  const r = tab.__data.findIndex(function (row, i) { return i >= 2 && row[0] === D1; });
  tab.__data[r][keys.indexOf('ACTIVE')] = 'TRUE';
  const before = plain(weekOf(env, D1));
  const resp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(resp.data.ok, true, JSON.stringify(resp));
  const after = plain(weekOf(env, D1));
  ['PRELUDE', 'HYMN_PRAISE', 'CALL_REF', 'CALL_TEXT'].forEach(function (k) {
    assert.strictEqual(after[k], before[k], k + ' 不可以被清空');
  });
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

test('M6c（審查 B2）舊分頁改名成功、之後 hideSheet 失敗 → 重跑：分頁照樣隱藏、有註解、有警告式保護，結果與一次跑完相同', function () {
  const clean = makeV1Env();
  run(clean);
  const fullSnap = function (env) {
    return JSON.stringify(env.contentSpreadsheet.getSheets().map(function (sh) {
      return { name: sh.getName(), hidden: sh.isSheetHidden(), data: sh.__data, note: sh.getRange(1, 1).getNote(),
        prot: (sh.__protections || []).map(function (p) { return [p.description, p.warningOnly]; }) };
    }));
  };
  const expected = fullSnap(clean);
  const env = makeV1Env();
  const callTab = env.contentTabs['宣召'];
  const realHide = callTab.hideSheet;
  let fired = false;
  callTab.hideSheet = function () {
    if (!fired) { fired = true; throw new Error('注入：hideSheet 失敗'); }
    return realHide.apply(callTab, arguments);
  };
  assert.strictEqual(env.sandbox.apiRunContentSheetBuild(QUARTER_ID).ok, false);
  const preview = env.sandbox.apiPreviewContentSheetBuild(QUARTER_ID).data;
  assert.ok(preview.lines.join('\n').indexOf('「宣召（已停用）」會補做：隱藏、A1 加註解、警告式保護') !== -1, preview.lines.join('\n'));
  run(env);
  const retired = env.contentSpreadsheet.getSheetByName('宣召（已停用）');
  assert.strictEqual(retired.isSheetHidden(), true);
  assert.ok(String(retired.getRange(1, 1).getNote()).indexOf('已停用') === 0);
  assert.strictEqual(fullSnap(env), expected, '重跑之後與一次跑完相同');
  // 已經是新版之後，有人把舊分頁取消隱藏 → 再按「建立／刷新」：只補隱藏，其餘一格不改。
  retired.showSheet();
  const again = run(env);
  assert.strictEqual(retired.isSheetHidden(), true);
  assert.ok(again.lines.join('\n').indexOf('補做：隱藏') !== -1, again.lines.join('\n'));
  assert.strictEqual(fullSnap(env), expected);
});

test('M6d（決定 6，審查 F6）「崇拜程序」凍結頭兩行及 A 欄；其他分頁不凍結欄', function () {
  const env = makeV1Env();
  run(env);
  assert.strictEqual(env.contentTabs['崇拜程序'].getFrozenRows(), 2);
  assert.strictEqual(env.contentTabs['崇拜程序'].getFrozenColumns(), 1);
  assert.strictEqual(env.contentSpreadsheet.getSheetByName('家事報告').getFrozenColumns(), 0);
});

test('M6e（審查 F8）上線前檢查與完成度自我檢測都有「內容表版本」：未移轉的季度報 🟡 並講明要按「建立／刷新本季內容表」；移轉之後 🟢', function () {
  const env = makeV1Env();
  const pick = function (items, label) { return plain(items).filter(function (i) { return i.label === label; })[0]; };
  const before = pick(env.sandbox.buildGoLiveChecklist_(), '上線前：內容表版本');
  assert.ok(before && before.status.indexOf('🟡') !== -1, JSON.stringify(before));
  assert.ok(before.message.indexOf(QUARTER_ID + '（這一季）的內容表是舊版，未移轉') !== -1 && before.message.indexOf('建立／刷新本季內容表') !== -1, before.message);
  assertWrittenChinese(assert, '內容表版本', before.message);
  const selfBefore = pick(env.sandbox.runSelfCheck_().items, '內容表版本');
  assert.strictEqual(selfBefore.status, before.status);
  run(env);
  const after = pick(env.sandbox.buildGoLiveChecklist_(), '上線前：內容表版本');
  assert.ok(after.status.indexOf('🟢') !== -1, JSON.stringify(after));
  assert.ok(after.message.indexOf(QUARTER_ID) !== -1, after.message);
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

test('（審查 C5）序樂留空：填寫介面的程序預覽（真入口 apiPreviewProgram）與 Word／電郵用的資料模型一樣印 PRELUDE_DEFAULT', function () {
  const env = makeV1Env({ config: { PRELUDE_DEFAULT: '預設序樂' } });
  run(env);
  const sb = env.sandbox;
  sb.writeSheet('ProgramTemplates', sb.seedProgramTemplatesRows_());
  const prev = sb.apiPreviewProgram(D1, { PRELUDE: '' });
  assert.strictEqual(prev.ok, true, JSON.stringify(prev));
  const row = (prev.data.rows || []).filter(function (x) { return x.itemName === '序樂'; })[0];
  sb.writeBulletinWeekField_(D1, 'PRELUDE', '');
  const model = sb.buildBulletinModel_(D1);
  const mrow = (model.program || []).filter(function (x) { return x.itemName === '序樂'; })[0];
  assert.ok(row && mrow, '兩邊都有序樂那一行');
  assert.strictEqual(row.content, mrow.content);
  assert.ok(String(row.content).indexOf('預設序樂') !== -1, JSON.stringify(row));
});

test('（審查 D1）選單「季度工具 ▸ 還原到某個備份」（真入口 menuRestoreQuarter_）：序樂、宣召等以內容表為來源的欄同時寫 FieldOverride，之後整季匯入不會靜靜改回內容表的值；還原的值與內容表相同就取消覆寫', function () {
  const env = makeV1Env();
  run(env);
  const sb = env.sandbox;
  assert.strictEqual(sb.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  sb.createFillBackup_(QUARTER_ID, 'MANUAL');
  // 之後同工在內容表改了序樂與宣召經文，匯入過。
  const tab = env.contentTabs['崇拜程序'];
  const keys = tab.__data[1];
  const r = tab.__data.findIndex(function (row, i) { return i >= 2 && row[0] === D1; });
  tab.__data[r][keys.indexOf('PRELUDE')] = '之後的序樂';
  tab.__data[r][keys.indexOf('CALL_TEXT')] = '之後的經文';
  assert.strictEqual(sb.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  assert.strictEqual(weekOf(env, D1).PRELUDE, '之後的序樂');

  const answers = [QUARTER_ID, '1'];
  const realGetUi = sb.SpreadsheetApp.getUi;
  sb.SpreadsheetApp.getUi = function () {
    const ui = realGetUi();
    ui.prompt = function () {
      const text = answers.shift();
      return { getSelectedButton: function () { return ui.Button.OK; }, getResponseText: function () { return text; } };
    };
    ui.alert = function () { return ui.Button.YES; };
    return ui;
  };
  sb.menuRestoreQuarter_();
  sb.SpreadsheetApp.getUi = realGetUi;

  assert.strictEqual(weekOf(env, D1).PRELUDE, '序樂甲', '還原有寫');
  const active = sb.readSheet('FieldOverride').filter(function (o) { return o.ACTIVE === true; });
  assert.ok(active.some(function (o) { return o.FIELD_KEY === 'PRELUDE' && o.OVERRIDE_VALUE === '序樂甲'; }), JSON.stringify(plain(active)));
  assert.ok(active.some(function (o) { return o.FIELD_KEY === 'CALL_TEXT' && o.OVERRIDE_VALUE === '經文甲'; }));

  assert.strictEqual(sb.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  assert.strictEqual(weekOf(env, D1).PRELUDE, '序樂甲', '匯入不蓋過還原的值');
  assert.strictEqual(weekOf(env, D1).CALL_TEXT, '經文甲');

  // 再還原到「還原之前」那一個備份（最新一個）：值與內容表相同。已有覆寫的欄一律寫入覆寫（審查第二輪 3），
  //    下一次匯入見到覆寫值與內容表相同，按 F5 規則自動解除，之後跟隨內容表。
  answers.push(QUARTER_ID, '1');
  sb.SpreadsheetApp.getUi = function () {
    const ui = realGetUi();
    ui.prompt = function () {
      const text = answers.shift();
      return { getSelectedButton: function () { return ui.Button.OK; }, getResponseText: function () { return text; } };
    };
    ui.alert = function () { return ui.Button.YES; };
    return ui;
  };
  sb.menuRestoreQuarter_();
  sb.SpreadsheetApp.getUi = realGetUi;
  assert.strictEqual(weekOf(env, D1).PRELUDE, '之後的序樂');
  assert.strictEqual(sb.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  const stillActive = sb.readSheet('FieldOverride').filter(function (o) {
    return o.ACTIVE === true && (o.FIELD_KEY === 'PRELUDE' || o.FIELD_KEY === 'CALL_TEXT');
  });
  assert.strictEqual(stillActive.length, 0, JSON.stringify(plain(stillActive)));
  assert.strictEqual(weekOf(env, D1).PRELUDE, '之後的序樂');
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

// =====================================================================
// Commit 7：填寫介面的第三種模式說明＋待填提示
// =====================================================================

console.log('\n填寫介面與待填提示');

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
}

/** 把 Script.html 的 renderContentSheetBar() 一段抽出來，在假 DOM 上真的執行。 */
function loadBarRegion() {
  const js = readSrc('src/ui/Script.html');
  const start = js.indexOf('  var CONTENT_SHEET_BAR_OVERRIDABLE_SOURCE');
  const end = js.indexOf('  // BEGIN confirm-dialog');
  assert.ok(start !== -1 && end > start, '找不到狀態列那一段');
  function makeEl(tag) {
    const node = {
      tag: tag, textContent: '', children: [], attrs: {}, classes: new Set(), innerHTML: '',
      classList: { add: function (c) { node.classes.add(c); } },
      appendChild: function (c) { node.children.push(c); return c; },
      getAttribute: function (k) { return node.attrs[k] === undefined ? null : node.attrs[k]; }
    };
    return node;
  }
  const ctx = {
    el: function (tag) { return makeEl(tag); },
    makeSmallButton: function (label) { const b = makeEl('button'); b.textContent = label; return b; },
    startContentImport: function () {}
  };
  vm.createContext(ctx);
  vm.runInContext(js.slice(start, end) + '\nthis.render = renderContentSheetBar;', ctx);
  return { render: ctx.render, makeEl: makeEl };
}

function barText(bar) {
  return bar.children.map(function (c) { return c.textContent; }).join('');
}

test('T7-1 甲區塊（overridable）狀態列講明來自內容表「崇拜程序」、在這裏改等於覆寫；其他區塊照舊', function () {
  const t = loadBarRegion();
  const over = t.makeEl('div');
  over.attrs['data-content-sheet-bar'] = 'overridable';
  t.render(over, { exists: true, fileUrl: 'https://example.invalid/x', lastImportedAt: '2027-10-01 10:00' });
  const text = barText(over);
  ['本區內容來自內容表「崇拜程序」', '在這裏改等於覆寫，之後匯入不會蓋過', '最後匯入：2027-10-01 10:00', '重新匯入（只限這一個主日）'].forEach(function (piece) {
    assert.ok(text.indexOf(piece) !== -1, '缺少：' + piece + '\n' + text);
  });
  const none = t.makeEl('div');
  none.attrs['data-content-sheet-bar'] = 'overridable';
  t.render(none, { exists: false });
  assert.ok(barText(none).indexOf('「崇拜程序」') !== -1 && barText(none).indexOf('本季尚未建立內容表') !== -1, barText(none));

  const plainBar = t.makeEl('div');
  plainBar.attrs['data-content-sheet-bar'] = '';
  t.render(plainBar, { exists: true, fileUrl: 'https://example.invalid/x', lastImportedAt: '' });
  assert.ok(barText(plainBar).indexOf('本區內容來自內容表，最後匯入：尚未匯入過') === 0, barText(plainBar));
  assertWrittenChinese(assert, '狀態列', [text, barText(none)]);
});

test('T7-2 Index.html：甲區塊頂有 overridable 狀態列；舊的「宣召由內容表接管」註解已拿走；浸禮提示指向「崇拜程序」；註解內沒有樣板標籤', function () {
  const html = readSrc('src/ui/Index.html');
  const blockA = html.slice(html.indexOf('<h2>甲、崇拜程序</h2>'), html.indexOf('<h2>乙、上週崇拜人數</h2>'));
  assert.ok(blockA.indexOf('<div data-content-sheet-bar="overridable"></div>') !== -1);
  assert.ok(blockA.indexOf('data-content-sheet-bar="overridable"') < blockA.indexOf('<div class="field-grid">'), '狀態列在區塊頂');
  assert.strictEqual(blockA.split('data-content-sheet-bar').length - 1, 1, '甲區塊只有一條狀態列');
  assert.strictEqual(html.indexOf('由內容表接管（R-011）'), -1);
  assert.strictEqual(html.indexOf('內容表「浸禮合堂」分頁'), -1);
  assert.ok(html.indexOf('內容表「崇拜程序」分頁</strong>（浸禮六欄）') !== -1);
  const comments = html.match(/<!--[\s\S]*?-->/g) || [];
  comments.forEach(function (c) { assert.strictEqual(c.indexOf('<?'), -1, '註解內不可以有樣板標籤：' + c); });
});

test('T7-3 真入口 apiLoadWeek：宣召、讀經經文、證道講題、回應詩歌的待填說明講明「請在內容表「崇拜程序」填寫。」；宣召不在唯讀清單', function () {
  const env = contentEnv.makeEnv({ weekRows: [{ SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID }] });
  const resp = env.sandbox.apiLoadWeek(D1);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  const all = Array.from(resp.data.missingSplit.required).concat(Array.from(resp.data.missingSplit.optional));
  const byField = {};
  all.forEach(function (m) { byField[m.field] = m.reason; });
  assert.strictEqual(byField.CALL_TEXT, '宣召經文與出處兩者皆未填。請在內容表「崇拜程序」填寫。');
  ['SCRIPTURE_REF', 'SERMON_TITLE', 'RESPONSE_HYMN'].forEach(function (k) {
    assert.strictEqual(byField[k], '請在內容表「崇拜程序」填寫。', k);
  });
  assert.strictEqual(byField.FLOWER_THIS_WEEK, '通常空白，有就填。', '不是內容表的欄照舊');
  assert.strictEqual(Array.from(resp.data.readOnly.readOnlyFields.week).indexOf('CALL_REF'), -1);
  assertWrittenChinese(assert, '待填說明', [byField.CALL_TEXT, byField.SERMON_TITLE]);
});

test('T7-4 真入口 apiQuarterMissingReport（本季待填清單）：那幾行附「請在內容表「崇拜程序」填寫。」', function () {
  const env = contentEnv.makeEnv({ weekRows: [{ SERVICE_DATE: D1, QUARTER_ID: QUARTER_ID }] });
  const resp = env.sandbox.apiQuarterMissingReport(QUARTER_ID);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  const lines = Array.from(resp.data.lines);
  const sermon = lines.filter(function (l) { return l.indexOf(D1) === 0 && l.indexOf('（SERMON_TITLE）') !== -1; })[0];
  assert.ok(sermon && sermon.indexOf('請在內容表「崇拜程序」填寫。') !== -1, JSON.stringify(lines.slice(0, 12)));
  const flower = lines.filter(function (l) { return l.indexOf('（FLOWER_THIS_WEEK）') !== -1; })[0];
  assert.ok(flower && flower.indexOf('請在內容表') === -1, flower);
});

// =====================================================================
// Commit 8：_說明、邀請信、A1 註解
// =====================================================================

console.log('\n_說明、邀請信、A1 註解');

test('C8-1 移轉之後（真入口）_說明：一個主日一行、誰填哪幾欄、講員可以自己填、四條規則（不插入／刪除／移動欄）、已停用的舊分頁', function () {
  const env = makeV1Env();
  run(env);
  const text = env.contentTabs['_說明'].__data.map(function (r) { return r[0]; }).join('\n');
  ['【「崇拜程序」：一個主日一行】', '每個主日已經預先開好一行，請直接修改那一行，不要另加一行',
    '講員：填「讀經經文」與「證道講題」', '多數講員已經有權限，可以自己開這個檔案填', '交給幹事代填',
    '領詩：填「序樂」「詩歌頌讚」「回應詩歌」', '幹事：填「宣召出處」「宣召經文」及浸禮六欄',
    '序樂留空＝週報印預設序樂', '【「讀經經文」不是讀經的人】', '【填寫介面改過的格】', '【四條規則，請務必遵守】',
    '4. 請勿插入、刪除或移動欄', '熱烈歡迎來賓', '【已停用的舊分頁】', '「宣召（已停用）」「浸禮合堂（已停用）」已經隱藏',
    '崇拜程序：講員、領詩、幹事'
  ].forEach(function (piece) { assert.ok(text.indexOf(piece) !== -1, '_說明缺少：' + piece); });
  assert.strictEqual(text.indexOf('宣召：'), -1, '負責人清單不可以再有「宣召」分頁');
  assertWrittenChinese(assert, '_說明', text.split('\n'));
});

test('C8-2 新建（沒有舊分頁）的 _說明不印「已停用的舊分頁」一段', function () {
  const sb = contentEnv.makeEnv({}).sandbox;
  const lines = Array.from(sb.buildContentSheetInstructionLines_({
    quarterId: QUARTER_ID, serviceDates: contentEnv.SERVICE_DATES, owners: {}, deadlineNote: '', adminContact: 'x', seededSample: false
  }));
  assert.strictEqual(lines.join('\n').indexOf('已停用的舊分頁'), -1);
});

test('C8-3 邀請信講明講員可以直接在「崇拜程序」填讀經經文與證道講題；規則加「請勿插入、刪除或移動欄」', function () {
  const sb = contentEnv.makeEnv({}).sandbox;
  const html = sb.buildContentSheetInviteHtml_({
    quarterId: QUARTER_ID, fileUrl: 'https://example.invalid/x', serviceDates: contentEnv.SERVICE_DATES,
    owners: sb.parseContentSheetOwners_(sb.defaultConfigValueFor_('CONTENT_SHEET_OWNERS')), deadlineNote: '截止', churchName: '教會'
  });
  assert.ok(html.indexOf('講員可以直接在「崇拜程序」分頁填讀經經文與證道講題') !== -1, html);
  assert.ok(html.indexOf('請勿插入、刪除或移動欄') !== -1);
  assert.ok(html.indexOf('講員、領詩、幹事') !== -1, '負責人表用新的預設值');
  assertWrittenChinese(assert, '邀請信', [html]);
});

test('C8-4 「崇拜程序」A1 註解：負責人、截止日期、一個主日一行、不是讀經的人', function () {
  const sb = contentEnv.makeEnv({}).sandbox;
  const def = sb.contentSheetWorshipTabDef_();
  const note = sb.buildContentSheetTabNote_(def, sb.parseContentSheetOwners_(sb.defaultConfigValueFor_('CONTENT_SHEET_OWNERS')), '星期三前');
  ['負責：講員、領詩、幹事', '星期三前', '每個主日已經預先開好一行', '不是讀經的人', '序樂留空時週報印預設序樂'].forEach(function (piece) {
    assert.ok(note.indexOf(piece) !== -1, '缺少：' + piece + '\n' + note);
  });
  assertWrittenChinese(assert, 'A1 註解', [note]);
});

test('C8-5 _README：季度填寫表、講員表格、FillSnapshot 三行講明已停用、資料保留', function () {
  const sb = contentEnv.makeEnv({}).sandbox;
  const lines = Array.from(sb.readmeContentLines_());
  ['FillSnapshot：', 'SpeakerFormSubmissions：', 'Fill_<季度>：'].forEach(function (prefix) {
    const line = lines.filter(function (l) { return l.indexOf(prefix) === 0; })[0];
    assert.ok(line && line.indexOf('已停用') !== -1 && line.indexOf('保留') !== -1, line);
  });
});

console.log('\n審查第二輪');

/** 「崇拜程序」某主日最後一行生效中的那一行在 __data 的位置。 */
function worshipRowIndex(env, iso) {
  const data = env.contentTabs['崇拜程序'].__data;
  let idx = -1;
  data.forEach(function (row, i) { if (i >= 2 && row[0] === iso) idx = i; });
  return idx;
}

/** 第一次移轉在 cellWrites 寫了 n 格之後失敗。 */
function failAfterCellWrites(env, n) {
  const plan = env.sandbox.planContentSheetV2Migration_(Object.assign(env.sandbox.readContentSheetV2Inputs_(env.contentSpreadsheet),
    { serviceDates: contentEnv.SERVICE_DATES, created: false }));
  assert.ok(plan.cellWrites.length > n, '前提：cellWrites 多過 ' + n + ' 格');
  env.contentFaults.failOnSetValue = n + 1;
  const failed = env.sandbox.apiRunContentSheetBuild(QUARTER_ID);
  assert.ok(failed.ok === false || (failed.data && failed.data.ok === false), JSON.stringify(failed));
  env.contentFaults.failOnSetValue = null;
  return plan;
}

test('R2-A6a 第一次寫了一半失敗 → 期間幹事經真入口 apiSaveWeek 改了同一格（序樂）→ 重跑照常完成：那一格是移轉自己寫的，列入「兩邊不同」保留現值，不整次拒絕', function () {
  const env = makeV1Env();
  const plan = failAfterCellWrites(env, 2);
  assert.ok(plan.cellWrites.slice(0, 2).some(function (w) { return w.key === 'PRELUDE' && w.isoDate === D1; }), JSON.stringify(plain(plan.cellWrites.slice(0, 2))));
  const loaded = env.sandbox.apiLoadWeek(D1);
  const saved = env.sandbox.apiSaveWeek({ isoDate: D1, lastSavedAt: loaded.data.lastSavedAt,
    baseWeek: { PRELUDE: loaded.data.week.PRELUDE }, week: { PRELUDE: '幹事後來改的序樂' }, dutyEdits: [] });
  assert.strictEqual(saved.ok, true, JSON.stringify(saved));
  const data = run(env);
  const text = data.lines.join('\n');
  assert.ok(text.indexOf('上一次移轉中途停止') !== -1, text);
  assert.ok(text.indexOf('「序樂」：崇拜程序「序樂甲」，週報「幹事後來改的序樂」') !== -1, text);
  assert.strictEqual(rowOf(env, D1)[0].PRELUDE, '序樂甲', '保留崇拜程序的值');
});

test('R2-A6b 第一次寫了一半失敗 → 期間有人在最底為同一主日加了一行（目標行轉移）→ 重跑不整次拒絕', function () {
  const env = makeV1Env();
  const plan = failAfterCellWrites(env, 3);
  assert.ok(plan.cellWrites.slice(0, 3).some(function (w) { return w.isoDate === D1; }));
  const tab = env.contentTabs['崇拜程序'];
  const keys = tab.__data[1];
  const row = keys.map(function () { return ''; });
  row[0] = D1; row[keys.indexOf('SERMON_TITLE')] = '講題甲（更正）'; row[keys.indexOf('ACTIVE')] = 'TRUE';
  tab.__data.push(row);
  const resp = env.sandbox.apiRunContentSheetBuild(QUARTER_ID);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp));
  assert.strictEqual(resp.data.ok, true, JSON.stringify(resp.data));
});

test('R2-A6c 第一次因為新欄位置有字被拒絕（一格未寫）→ 不留「移轉已開始」記錄；清走之前再按仍然拒絕', function () {
  const env = makeV1Env();
  const tab = env.contentTabs['崇拜程序'];
  const col = v2Keys(env).indexOf('HYMN_PRAISE');
  while (tab.__data[2].length <= col) tab.__data[2].push('');
  tab.__data[2][col] = '備忘';
  assert.strictEqual(env.sandbox.apiRunContentSheetBuild(QUARTER_ID).data.reason, 'NEW_COLUMNS_NOT_EMPTY');
  assert.strictEqual(env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'CONTENT_SHEET_MIGRATE_V2_START'; }).length, 0);
  assert.strictEqual(env.sandbox.apiRunContentSheetBuild(QUARTER_ID).data.reason, 'NEW_COLUMNS_NOT_EMPTY');
});

test('R2-B2a 改名成功、hideSheet 失敗 → AuditLog 已有「宣召 → 宣召（已停用）」與格子摘要；重跑之後另有補做一筆', function () {
  const env = makeV1Env();
  const call = env.contentTabs['宣召'];
  const real = call.hideSheet;
  let fired = false;
  call.hideSheet = function () { if (!fired) { fired = true; throw new Error('注入'); } return real.apply(call, arguments); };
  assert.strictEqual(env.sandbox.apiRunContentSheetBuild(QUARTER_ID).ok, false);
  const audits = function () { return env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'CONTENT_SHEET_MIGRATE_V2'; }); };
  assert.ok(audits().some(function (a) { return a.FIELD === '宣召' && a.NEW_VALUE === '宣召（已停用）'; }), '改名一成功就記');
  assert.ok(audits().some(function (a) { return a.FIELD === '崇拜程序'; }), '格子摘要已記');
  run(env);
  assert.ok(audits().some(function (a) { return a.FIELD === '宣召（已停用）' && String(a.NEW_VALUE).indexOf('隱藏') !== -1; }));
});

test('R2-B2b 已停用的舊分頁另有保護（說明不同或嚴格保護）→ 當作已保護，刷新不會再加保護、不改別人的說明', function () {
  const env = makeV1Env();
  run(env);
  const retired = env.contentSpreadsheet.getSheetByName('宣召（已停用）');
  retired.__protections[0].description = '幹事：只限幹事修改';
  retired.__protections[0].warningOnly = false;
  run(env);
  run(env);
  assert.deepStrictEqual(plain(retired.__protections.map(function (p) { return [p.description, p.warningOnly]; })), [['幹事：只限幹事修改', false]]);
});

test('R2-F6 凍結 A 欄失敗（例如合併了跨欄的格）→ 其餘版面、_說明照做；ErrorLog 一行 CONTENT_SHEET_FREEZE_FAILED', function () {
  const env = makeV1Env();
  env.contentTabs['崇拜程序'].setFrozenColumns = function () { throw new Error('You cannot freeze columns that contain only part of a merged cell.'); };
  const data = run(env);
  assert.strictEqual(data.ok, true);
  const errs = env.sandbox.readSheet('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'CONTENT_SHEET_FREEZE_FAILED'; });
  assert.strictEqual(errs.length, 1, JSON.stringify(plain(env.sandbox.readSheet('ErrorLog'))));
  assert.ok(String(env.contentSpreadsheet.getSheetByName('_說明').__data.map(function (r) { return r[0]; }).join('\n')).indexOf('崇拜程序') !== -1);
});

function restoreLatestViaMenu(sb, alerts) {
  const answers = [QUARTER_ID, '1'];
  const realGetUi = sb.SpreadsheetApp.getUi;
  sb.SpreadsheetApp.getUi = function () {
    const ui = realGetUi();
    ui.prompt = function () {
      const text = answers.shift();
      return { getSelectedButton: function () { return ui.Button.OK; }, getResponseText: function () { return text; } };
    };
    ui.alert = function (title, message) { if (alerts) alerts.push(String(title) + '｜' + String(message || '')); return ui.Button.YES; };
    return ui;
  };
  try { sb.menuRestoreQuarter_(); } finally { sb.SpreadsheetApp.getUi = realGetUi; }
}

test('R2-D1a 覆寫之後內容表再改過，還原到覆寫之前的備份（真入口 menuRestoreQuarter_）→ 覆寫保留，下一次匯入不會改成內容表的新值', function () {
  const env = makeV1Env();
  run(env);
  const sb = env.sandbox;
  assert.strictEqual(sb.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  sb.createFillBackup_(QUARTER_ID, 'MANUAL');
  const l = sb.apiLoadWeek(D1).data;
  assert.strictEqual(sb.apiSaveWeek({ isoDate: D1, lastSavedAt: l.lastSavedAt, baseWeek: { PRELUDE: l.week.PRELUDE },
    week: { PRELUDE: '覆寫序樂' }, dutyEdits: [] }).ok, true);
  const tab = env.contentTabs['崇拜程序'];
  tab.__data[worshipRowIndex(env, D1)][tab.__data[1].indexOf('PRELUDE')] = '內容表新序樂';
  assert.strictEqual(sb.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  assert.strictEqual(weekOf(env, D1).PRELUDE, '覆寫序樂', '前提：覆寫未被蓋過');
  restoreLatestViaMenu(sb);
  assert.strictEqual(weekOf(env, D1).PRELUDE, '序樂甲');
  assert.strictEqual(sb.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  assert.strictEqual(weekOf(env, D1).PRELUDE, '序樂甲', '還原的值不可以被下一次匯入靜靜改走');
});

test('R2-D1b 還原時寫 FieldOverride 失敗 → 週報一格未改（先寫覆寫、後寫週報）；處理好之後再按一次就完成', function () {
  const env = makeV1Env();
  run(env);
  const sb = env.sandbox;
  assert.strictEqual(sb.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  sb.createFillBackup_(QUARTER_ID, 'MANUAL');
  const tab = env.contentTabs['崇拜程序'];
  tab.__data[worshipRowIndex(env, D1)][tab.__data[1].indexOf('PRELUDE')] = '之後的序樂';
  assert.strictEqual(sb.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  const fo = env.sheets.FieldOverride;
  const realGetRange = fo.getRange;
  fo.getRange = function () {
    const rg = realGetRange.apply(fo, arguments);
    rg.setValues = function () { throw new Error('注入：FieldOverride 寫入失敗'); };
    rg.setValue = function () { throw new Error('注入：FieldOverride 寫入失敗'); };
    return rg;
  };
  const alerts = [];
  restoreLatestViaMenu(sb, alerts);
  fo.getRange = realGetRange;
  assert.ok(alerts.join('\n').indexOf('還原失敗') !== -1, alerts.join('\n'));
  assert.strictEqual(weekOf(env, D1).PRELUDE, '之後的序樂', '週報一格未改');
  // 處理好之後再按（揀第 2 個：第 1 個是剛才「還原之前」自動多做的備份）。
  const answers = [QUARTER_ID, '2'];
  const realGetUi = sb.SpreadsheetApp.getUi;
  sb.SpreadsheetApp.getUi = function () {
    const ui = realGetUi();
    ui.prompt = function () { const t = answers.shift(); return { getSelectedButton: function () { return ui.Button.OK; }, getResponseText: function () { return t; } }; };
    ui.alert = function () { return ui.Button.YES; };
    return ui;
  };
  sb.menuRestoreQuarter_();
  sb.SpreadsheetApp.getUi = realGetUi;
  assert.strictEqual(weekOf(env, D1).PRELUDE, '序樂甲');
  assert.strictEqual(sb.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  assert.strictEqual(weekOf(env, D1).PRELUDE, '序樂甲', '覆寫已寫好，匯入不蓋過');
});

test('R2-F8a 已登記但開不到的內容表 → 🟡「開不到」，建議核對檔案，不叫人按「建立／刷新」；ContentSheets 工作表讀不到 → 🟡「核對不到」', function () {
  const env = contentEnv.makeEnv({ contentLayout: 'current', content: {}, contentFileMissing: true, weekRows: baseOptions().weekRows });
  const item = plain(env.sandbox.buildGoLiveChecklist_()).filter(function (i) { return i.label === '上線前：內容表版本'; })[0];
  assert.ok(item.status.indexOf('🟡') !== -1, JSON.stringify(item));
  assert.ok(item.message.indexOf('開不到') !== -1 && item.message.indexOf('「開啟內容表」核對') !== -1, item.message);
  assert.strictEqual(item.message.indexOf('建立／刷新本季內容表'), -1, item.message);
  assertWrittenChinese(assert, '內容表開不到', item.message);
  const st = plain(env.sandbox.buildContentSheetVersionItem_({ ok: false, error: '讀不到 ContentSheets 工作表：x', checked: [], problems: [] },
    env.sandbox.SELF_CHECK_STATUS_));
  assert.ok(st.message.indexOf('核對不到') !== -1 && st.message.indexOf('初始化工作表') !== -1, st.message);
});

console.log('\n2026-10-23 部署後重測發現');

test('R3-1 填寫介面「重新匯入（只限這一個主日）」（真入口 apiPreviewContentImport）：只有「沒有蓋過」的格 → 講出來，不講「一致」；內容表改成與覆寫相同 → 預覽算一項「解除覆寫」，經確認寫入（apiRunContentImport）之後覆寫停用', function () {
  const env = makeV1Env();
  run(env);
  const sb = env.sandbox;
  assert.strictEqual(sb.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  const l = sb.apiLoadWeek(D1).data;
  assert.strictEqual(sb.apiSaveWeek({ isoDate: D1, lastSavedAt: l.lastSavedAt, baseWeek: { PRELUDE: l.week.PRELUDE },
    week: { PRELUDE: '介面序樂' }, dutyEdits: [] }).ok, true);

  const p1 = sb.apiPreviewContentImport(D1);
  assert.strictEqual(p1.ok, true, JSON.stringify(p1));
  const s1 = plain(p1.data.summary);
  assert.strictEqual(s1.added + s1.updated + s1.removed + s1.releases, 0, JSON.stringify(s1));
  assert.strictEqual(s1.conflicts, 1);
  assert.ok(s1.noChangeMessage.indexOf('沒有蓋過') !== -1 && s1.noChangeMessage.indexOf('「介面序樂」') !== -1
    && s1.noChangeMessage.indexOf('「序樂甲」') !== -1, s1.noChangeMessage);
  assert.strictEqual(s1.noChangeMessage.indexOf('一致'), -1, s1.noChangeMessage);
  assertWrittenChinese(assert, '沒有蓋過', s1.noChangeMessage);

  const tab = env.contentTabs['崇拜程序'];
  tab.__data[worshipRowIndex(env, D1)][tab.__data[1].indexOf('PRELUDE')] = '介面序樂';
  const p2 = plain(sb.apiPreviewContentImport(D1).data.summary);
  assert.strictEqual(p2.releases, 1, JSON.stringify(p2));
  const done = sb.apiRunContentImport(D1);
  assert.strictEqual(done.ok, true, JSON.stringify(done));
  assert.strictEqual(plain(done.data.summary).releases, 1);
  const active = sb.readSheet('FieldOverride').filter(function (o) { return o.ACTIVE === true && o.FIELD_KEY === 'PRELUDE'; });
  assert.strictEqual(active.length, 0, '覆寫已停用');
  const p3 = plain(sb.apiPreviewContentImport(D1).data.summary);
  assert.strictEqual(p3.noChangeMessage, '內容表與週報現況一致，沒有任何改動。');
});

test('R3-2 Script.html：單週匯入預覽把「解除覆寫」算作改動（經確認對話框），沒有改動時用伺服器的 noChangeMessage', function () {
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Script.html'), 'utf8');
  const fn = js.slice(js.indexOf('function onContentImportPreviewed('), js.indexOf('function onContentImportDone('));
  assert.ok(fn.indexOf('(summary.releases || 0)') !== -1, fn);
  assert.ok(fn.indexOf('summary.noChangeMessage') !== -1, fn);
  assert.ok(fn.indexOf('openConfirmDialog(') > fn.indexOf('summary.noChangeMessage'));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
