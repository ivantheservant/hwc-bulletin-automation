#!/usr/bin/env node
/**
 * tests/resultsB.test.js
 *
 * 2026-10-28 Ivan 測試結果 B 的修正：
 *   B1 載入一週（apiLoadWeek）時自動由內容表匯入那一週；「由內容表匯入」不再先預覽、不再問。
 *   B2 獻花兩格：職事表有名字而週報空白 → 輸入框直接顯示職事表的名字；等於職事表＝跟隨（存空白）。
 *   B3 程序表可以改次序（order）。
 *   B4 「開啟預覽」「預覽這個版本」＝產生 Word 存雲端硬碟再開（apiOpenWordPreview）。
 *
 * 一律經真正入口：apiLoadWeek、weeklyBulletinSendTrigger_ 經 autoImportContentForWeek_、apiOpenWordPreview、
 *   applyProgramEdits_（純函式）、Script.html 抽出來的真正程式碼。
 *
 * 執行方式：node tests/resultsB.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const contentEnv = require('./helpers/contentEnv');
const { makeFillEnv, QUARTER_ID } = require('./helpers/fillEnv');
const { makeWordEnv, OUTPUT_FOLDER } = require('./helpers/wordEnv');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

const [D1, D2] = contentEnv.SERVICE_DATES;

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
function readSrc(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

function weekOf(env, iso) {
  const sb = env.sandbox;
  return sb.readSheet_('BulletinWeeks').filter(function (r) {
    return sb.formatIsoDate_(sb.normalizeDate_(r.SERVICE_DATE)) === iso;
  })[0];
}

// =====================================================================
// B1：載入時自動匯入
// =====================================================================

console.log('\nB1：載入一週時自動由內容表匯入');

function makeContentEnv(extra) {
  return contentEnv.makeEnv(Object.assign({
    content: {
      崇拜程序: [
        { SERVICE_DATE: D1, SERMON_TITLE: '內容表的講題', ACTIVE: 'TRUE' },
        { SERVICE_DATE: D2, SERMON_TITLE: '第二週的講題', ACTIVE: 'TRUE' }
      ]
    }
  }, extra || {}));
}

test('RB1-1 apiLoadWeek：內容表改了講題 → 載入時自動匯入這一週，畫面即時見到；只動這一週；AuditLog 一行 CONTENT_AUTO_IMPORT_WEEK', function () {
  const env = makeContentEnv();
  const sb = env.sandbox;
  const resp = sb.apiLoadWeek(D1);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  assert.strictEqual(resp.data.autoImport.ran, true, JSON.stringify(resp.data.autoImport));
  assert.ok(resp.data.autoImport.changed >= 1, JSON.stringify(resp.data.autoImport));
  assert.strictEqual(String(weekOf(env, D1).SERMON_TITLE), '內容表的講題');
  assert.strictEqual(String(weekOf(env, D2).SERMON_TITLE || ''), '', '別的一週不動');
  assert.strictEqual(String(resp.data.week.SERMON_TITLE), '內容表的講題', '同一次載入已經見到新內容');
  const audits = sb.readSheet_('AuditLog').filter(function (r) { return r.ACTION === 'CONTENT_AUTO_IMPORT_WEEK'; });
  assert.strictEqual(audits.length, 1, JSON.stringify(sb.readSheet_('AuditLog').map(function (r) { return r.ACTION; })));
});

test('RB1-2 再載入一次（內容表沒有再改）→ 不寫任何東西（週報、AuditLog 不變），changed 是 0', function () {
  const env = makeContentEnv();
  const sb = env.sandbox;
  sb.apiLoadWeek(D1);
  const weeks = JSON.stringify(sb.readSheet_('BulletinWeeks'));
  const audit = sb.readSheet_('AuditLog').length;
  const again = sb.apiLoadWeek(D1);
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.data.autoImport.changed, 0);
  assert.strictEqual(JSON.stringify(sb.readSheet_('BulletinWeeks')), weeks);
  assert.strictEqual(sb.readSheet_('AuditLog').length, audit);
});

test('RB1-3 這一季沒有內容表 → 照常載入，autoImport 安靜（NO_CONTENT_SHEET），不寫 ErrorLog', function () {
  const env = makeContentEnv({ contentSheets: [] });
  const resp = env.sandbox.apiLoadWeek(D1);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  assert.strictEqual(resp.data.autoImport.ran, false);
  assert.strictEqual(resp.data.autoImport.reason, 'NO_CONTENT_SHEET');
  assert.strictEqual(env.sandbox.readSheet_('ErrorLog').length, 0);
});

test('RB1-4 內容表開不到（被刪了／沒有權限）→ 照常載入週報現有的內容，autoImport 有原因與訊息，畫面講一句', function () {
  const env = makeContentEnv({ contentFileMissing: true });
  const resp = env.sandbox.apiLoadWeek(D1);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  assert.strictEqual(resp.data.autoImport.changed, 0);
  assert.strictEqual(resp.data.autoImport.reason, 'FILE_MISSING');
  assert.ok(resp.data.autoImport.reason && ['NO_QUARTER', 'NO_CONTENT_SHEET', 'ARCHIVED'].indexOf(resp.data.autoImport.reason) === -1,
    JSON.stringify(resp.data.autoImport));
  assert.ok(String(resp.data.autoImport.message || '').length > 0);
});

test('RB1-5 前端 renderAutoImportNotice：有改動講「已自動由內容表更新這一週 N 項」；安靜的原因不講；其他原因講未能匯入；書面語', function () {
  const js = readSrc('src/ui/Script.html');
  const start = js.indexOf('  function renderAutoImportNotice(');
  const end = js.indexOf('  /**', start);
  const messages = [];
  const ctx = { showMessage: function (type, text) { messages.push({ type: type, text: text }); } };
  vm.createContext(ctx);
  vm.runInContext(js.slice(start, end) + '\nthis.fn = renderAutoImportNotice;', ctx);
  ctx.fn({ ran: true, changed: 2, reason: '', message: '' });
  ctx.fn({ ran: false, changed: 0, reason: 'NO_CONTENT_SHEET', message: '' });
  ctx.fn({ ran: true, changed: 0, reason: '', message: '' });
  ctx.fn(null);
  ctx.fn({ ran: false, changed: 0, reason: 'CONTENT_SHEET_OUTDATED', message: '內容表比系統舊。' });
  assert.deepStrictEqual(messages.map(function (m) { return m.text; }), [
    '已自動由內容表更新這一週 2 項（內容表最新的內容）。',
    '這一週未能自動由內容表匯入：內容表比系統舊。　畫面顯示的是週報現有的內容。'
  ]);
  assertWrittenChinese(assert, '自動匯入提示', messages.map(function (m) { return m.text; }));
  const onLoaded = js.slice(js.indexOf('function onWeekLoaded('), js.indexOf('function renderAutoImportNotice('));
  assert.ok(onLoaded.indexOf('renderAutoImportNotice(data.autoImport)') !== -1, '載入完成時要講');
});

test('RB1-6 apiLoadWeek 的後端（WebApp.gs）先自動匯入再讀；星期一觸發器在寄預覽通知之前亦先自動匯入', function () {
  const web = readSrc('src/WebApp.gs');
  const load = web.slice(web.indexOf('function apiLoadWeek('), web.indexOf('function apiLoadWeek(') + 500);
  assert.ok(load.indexOf("autoImportContentForWeek_(isoDate, 'WEBAPP_LOAD')") !== -1
    && load.indexOf("autoImportContentForWeek_(isoDate, 'WEBAPP_LOAD')") < load.indexOf('loadWeekForWebApp_(isoDate)'));
  assert.ok(readSrc('src/Trigger.gs').indexOf("autoImportContentForWeek_(targetIso, 'TRIGGER')") !== -1);
});

// =====================================================================
// B2：獻花預先填入
// =====================================================================

console.log('\nB2：獻花預先填入職事表的名字');

function loadFlowerForm(weekValues, flowerRoster) {
  const js = readSrc('src/ui/Script.html');
  const code = js.slice(js.indexOf('  var FLOWER_FIELD_ROSTER_KEYS'), js.indexOf('  // BEGIN flower-hint'));
  const inputs = ['FLOWER_THIS_WEEK', 'FLOWER_NEXT_WEEK', 'PAGE_TITLE'].map(function (key) {
    return { value: '', getAttribute: function () { return key; }, key: key };
  });
  const ctx = {
    state: { week: weekValues, flowerRoster: flowerRoster },
    document: { querySelectorAll: function () { return inputs; } }
  };
  vm.createContext(ctx);
  vm.runInContext(code + '\nthis.apply = applyWeekFieldsToForm; this.collect = collectWeekFieldsFromForm;', ctx);
  return { ctx: ctx, inputs: inputs };
}

test('RB2-1 週報獻花空白、職事表有名字 → 輸入框顯示職事表的名字；收集時當空白（跟隨職事表）；改了就送改的名字', function () {
  const f = loadFlowerForm({ FLOWER_THIS_WEEK: '', FLOWER_NEXT_WEEK: '', PAGE_TITLE: '標題' }, { thisWeek: '甲家庭', nextWeek: '乙家庭' });
  f.ctx.apply();
  assert.deepStrictEqual(f.inputs.map(function (i) { return i.value; }), ['甲家庭', '乙家庭', '標題']);
  assert.deepStrictEqual(plain(f.ctx.collect()), { FLOWER_THIS_WEEK: '', FLOWER_NEXT_WEEK: '', PAGE_TITLE: '標題' }, '沒有改＝空白，與載入時一樣，不算未儲存');
  f.inputs[0].value = '丙家庭';
  assert.strictEqual(f.ctx.collect().FLOWER_THIS_WEEK, '丙家庭');
});

test('RB2-2 週報已經人手填了別的名字 → 輸入框照顯示週報的名字；職事表沒有名字 → 空白照舊', function () {
  const f = loadFlowerForm({ FLOWER_THIS_WEEK: '人手名字', FLOWER_NEXT_WEEK: '', PAGE_TITLE: '' }, { thisWeek: '甲家庭', nextWeek: '' });
  f.ctx.apply();
  assert.deepStrictEqual(f.inputs.map(function (i) { return i.value; }), ['人手名字', '', '']);
  assert.deepStrictEqual(plain(f.ctx.collect()), { FLOWER_THIS_WEEK: '人手名字', FLOWER_NEXT_WEEK: '', PAGE_TITLE: '' });
});

// =====================================================================
// B3：程序表改次序
// =====================================================================

console.log('\nB3：程序表改次序');

function tplRows(names) {
  return names.map(function (n, i) { return { seqNo: i + 1, itemName: n, content: '', posture: '眾 坐', fullWidth: false, sourceRow: { ITEM_NAME: n } }; });
}

test('RB3-1 order 把「家事報告」移到「宣召」之前 → 印出來的次序跟 order；沒有列在 order 的行留在原位', function () {
  const sb = makeFillEnv({ withGrid: false }).sandbox;
  const rows = tplRows(['序樂', '宣召', '詩歌', '家事報告', '祝福']);
  const out = plain(sb.applyProgramEdits_(rows, JSON.stringify({
    v: 1, hidden: [], added: [],
    order: ['序樂#1', '家事報告#1', '宣召#1', '詩歌#1', '祝福#1']
  })));
  assert.deepStrictEqual(out.rows.map(function (r) { return r.itemName; }), ['序樂', '家事報告', '宣召', '詩歌', '祝福']);

  const partial = plain(sb.applyProgramEdits_(rows, JSON.stringify({ v: 1, order: ['祝福#1', '宣召#1'] })));
  assert.deepStrictEqual(partial.rows.map(function (r) { return r.itemName; }), ['序樂', '祝福', '詩歌', '家事報告', '宣召'],
    'order 只列兩行：兩行互換位置，其餘不動');
});

test('RB3-2 加的行亦可以排；拿走的行照樣跟次序（還原之後回到你排的位置）；order 有不存在的鍵就略過', function () {
  const sb = makeFillEnv({ withGrid: false }).sandbox;
  const rows = tplRows(['序樂', '宣召', '拍照', '祝福']);
  const edits = {
    v: 1, hidden: ['拍照#1'],
    added: [{ id: 'a1', after: '宣召#1', itemName: '特別分享' }],
    order: ['序樂#1', 'add:a1', '宣召#1', '拍照#1', '已經不在的#1', '祝福#1']
  };
  const out = plain(sb.applyProgramEdits_(rows, JSON.stringify(edits)));
  assert.deepStrictEqual(out.rows.map(function (r) { return r.itemName; }), ['序樂', '特別分享', '宣召', '祝福']);
  assert.deepStrictEqual(out.display.map(function (r) { return r.itemName + (r.removed ? '（拿走）' : ''); }),
    ['序樂', '特別分享', '宣召', '拍照（拿走）', '祝福']);
  edits.hidden = [];
  const restored = plain(sb.applyProgramEdits_(rows, JSON.stringify(edits)));
  assert.deepStrictEqual(restored.rows.map(function (r) { return r.itemName; }), ['序樂', '特別分享', '宣召', '拍照', '祝福']);
  assert.ok(sb.describeProgramEdits_(JSON.stringify(edits)).indexOf('改了次序') !== -1);
});

test('RB3-3 parseProgramEdits_：order 去重、去空白；不是陣列當沒有', function () {
  const sb = makeFillEnv({ withGrid: false }).sandbox;
  assert.deepStrictEqual(plain(sb.parseProgramEdits_(JSON.stringify({ v: 1, order: ['甲#1', '', '甲#1', '乙#1'] })).order), ['甲#1', '乙#1']);
  assert.deepStrictEqual(plain(sb.parseProgramEdits_(JSON.stringify({ v: 1, order: '甲#1' })).order), []);
});

test('RB3-4 前端：每一行有「↑」「↓」（頭尾停用）；按「↓」即時改畫面、order 寫入全部行的次序', function () {
  const js = readSrc('src/ui/Script.html');
  const section = js.slice(js.indexOf('var programAddAnchor'), js.indexOf('// END program-edits'));
  assert.ok(section.indexOf('function moveProgramRow(') !== -1);
  assert.ok(section.indexOf("'↑'") !== -1 && section.indexOf("'↓'") !== -1, '有上下按鈕');
  assert.ok(section.indexOf('edits.order = rows.map(programRowId)') !== -1);
  assert.ok(readSrc('src/ui/Index.html').indexOf('按「↑」「↓」可以改次序') !== -1);
});

// =====================================================================
// B4：Word 預覽
// =====================================================================

console.log('\nB4：開啟預覽＝Word');

const WD = '2027-11-07';

test('RB4-1 apiOpenWordPreview（已儲存）：產生 Word、更新這一期的最新 Word（記 DOC_ID），回傳雲端硬碟的網址；再按一次原地更新同一個檔', function () {
  const env = makeWordEnv();
  const sb = env.sandbox;
  const first = sb.apiOpenWordPreview(WD, {});
  assert.strictEqual(first.ok, true, JSON.stringify(first.error));
  assert.strictEqual(first.data.kind, 'SAVED');
  assert.ok(/^https:\/\//.test(first.data.url), first.data.url);
  const docId = String(weekOf(env, WD).DOC_ID || '');
  assert.ok(docId !== '', '記了最新 Word');
  assert.ok(first.data.url.indexOf(docId) !== -1, '網址就是最新 Word');
  const second = sb.apiOpenWordPreview(WD, {});
  assert.strictEqual(second.ok, true);
  assert.strictEqual(String(weekOf(env, WD).DOC_ID), docId, '同一個檔');
  assert.ok(sb.readSheet_('AuditLog').some(function (r) { return r.ACTION === 'BULLETIN_DOCX_WEBAPP_PREVIEW'; }));
});

test('RB4-2 apiOpenWordPreview（草稿）：另存「（草稿預覽）」在「版本預覽」子資料夾，不碰最新 Word、不寫週報；再按一次覆寫同一個檔', function () {
  const env = makeWordEnv();
  const sb = env.sandbox;
  const resp = sb.apiOpenWordPreview(WD, { draft: { week: { PAGE_TITLE: '草稿標題' }, dutyEdits: [], nextWeekDutyEdits: [] } });
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  assert.strictEqual(resp.data.kind, 'DRAFT');
  assert.ok(/（草稿預覽）\.docx$/.test(resp.data.fileName), resp.data.fileName);
  assert.strictEqual(String(weekOf(env, WD).DOC_ID || ''), '', '最新 Word 沒有動');
  assert.strictEqual(String(weekOf(env, WD).PAGE_TITLE || ''), '', '週報沒有寫');
  assert.strictEqual(env.drive.listFolderFiles(OUTPUT_FOLDER).length, 0, '不放在輸出資料夾本身');
  const again = sb.apiOpenWordPreview(WD, { draft: { week: { PAGE_TITLE: '草稿標題二' }, dutyEdits: [], nextWeekDutyEdits: [] } });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.data.url, resp.data.url, '原地覆寫同一個檔');
});

test('RB4-3 沒有設定輸出資料夾 → 明確的錯誤（不是靜靜失敗）；草稿帶了只在內容表輸入的欄位 → 與儲存同一道檢查拒絕', function () {
  const env = makeWordEnv({ noFolder: true });
  const resp = env.sandbox.apiOpenWordPreview(WD, {});
  assert.strictEqual(resp.ok, false);
  assert.ok(String(resp.error.message).indexOf('BULLETIN_OUTPUT_FOLDER_ID') !== -1, resp.error.message);
  const env2 = makeWordEnv();
  const refused = env2.sandbox.apiOpenWordPreview(WD, { draft: { week: { SERMON_TITLE: '不可以' } } });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.error.code, 'CONTENT_SHEET_READONLY');
});

test('RB4-4 前端：「開啟預覽」是按鈕，按了在 click 之內同步開新分頁再叫 apiOpenWordPreview；擋了出後備連結；逾時有自己的一句', function () {
  const js = readSrc('src/ui/Script.html');
  const html = readSrc('src/ui/Index.html');
  assert.ok(html.indexOf('<button id="previewLink" type="button"') !== -1);
  assert.ok(html.indexOf('<button id="snapshotPreviewLink" type="button"') !== -1);
  assert.ok(html.indexOf('id="wordPreviewFallbackLink"') !== -1);
  const start = js.slice(js.indexOf('function startWordPreview('), js.indexOf('function triggerBinaryDownload('));
  assert.ok(start.indexOf("window.open('', '_blank')") !== -1 && start.indexOf("window.open('', '_blank')") < start.indexOf("callServer('apiOpenWordPreview'"),
    '新分頁要在叫伺服器之前同步開');
  assert.ok(start.indexOf('fallback.href = url') !== -1);
  assert.ok(js.indexOf("apiOpenWordPreview: 'wordpreview'") !== -1);
  assert.ok(js.indexOf("if (kind === 'wordpreview')") !== -1);
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
