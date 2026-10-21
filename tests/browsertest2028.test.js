#!/usr/bin/env node
/**
 * tests/browsertest2028.test.js
 *
 * 2028T2 瀏覽器無人看管測試（2026-10-21）之後的修正：
 *   F3　「發佈到 master 連結」載入時不可以已經勾選
 *   F4　R-046：事奉框維持「讀經」，介面欄位叫「讀經經文」
 *   F6　「待填」的數字統一只數「一定要填」
 *   F9　Web App 不再用瀏覽器原生 window.confirm()
 *   F10 字眼：字串常值不帶 Markdown 的 **、未建立內容表的訊息、預覽頁日期格式提示
 *
 * F1／F2／F8 在 tests/threewaysave.test.js；F5 在 tests/fieldoverride.test.js 的
 * 「第 8 組」；F7 在 tests/publish.test.js 的 F7-1 至 F7-5。
 *
 * 執行方式：node tests/browsertest2028.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeFillEnv, QUARTER_ID } = require('./helpers/fillEnv');
const { extractStringLiterals } = require('./helpers/stringLiterals');
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
    console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err));
  }
}

const D = '2027-11-07';
const ROOT = path.join(__dirname, '..');

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

/** 一個在記憶體內的 PropertiesService 替身。 */
function makePropertiesStub() {
  const store = {};
  return {
    store: store,
    stub: {
      getUserProperties: function () {
        return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
          setProperty: function (k, v) { store[k] = String(v); return this; }
        };
      },
      getScriptProperties: function () {
        return { getProperty: function () { return null; }, setProperty: function () { return this; } };
      }
    }
  };
}

// =====================================================================
// F3：doPublish 永遠以 false 載入
// =====================================================================

console.log('\nF3：「發佈到 master 連結」永遠以未勾選載入');

test('F3-1 從未記住過 → doPublish 是 false', function () {
  const props = makePropertiesStub();
  const env = makeFillEnv({ withGrid: false, extraStubs: { PropertiesService: props.stub } });
  const panel = env.sandbox.publishPanelDataForWebApp_();
  assert.strictEqual(panel.prefs.doPublish, false);
});

test('F3-2 已記住 doPublish:true（舊版存的）→ 載入仍然是 false；doSend 與群組照舊記住', function () {
  const props = makePropertiesStub();
  const env = makeFillEnv({ withGrid: false, extraStubs: { PropertiesService: props.stub } });

  // 經真正入口 apiSavePublishPrefs() 記住：三樣都勾。
  const saved = env.sandbox.apiSavePublishPrefs({ doPublish: true, doSend: true, groups: ['CC', 'DB'] });
  assert.strictEqual(saved.ok, true, JSON.stringify(saved));
  // 前提：舊值真的存進去了（doPublish:true 被如實記住），讀出來時才被強制改成 false。
  const rawKey = env.sandbox.PUBLISH_PREFS_KEY_;
  assert.strictEqual(JSON.parse(props.store[rawKey]).doPublish, true, '前提：存的時候沒有被改動');

  const panel = env.sandbox.publishPanelDataForWebApp_();
  assert.strictEqual(panel.prefs.doPublish, false, '⚠️ 發佈會覆寫 master 連結，不可以靠記憶勾選');
  assert.strictEqual(panel.prefs.doSend, true, '寄出照舊記住');
  assert.deepStrictEqual(Array.from(panel.prefs.groups), ['CC', 'DB'], '群組照舊記住');
});

test('F3-3 直接把 doPublish:true 寫進偏好原文（模擬舊資料）→ 載入仍然是 false', function () {
  const props = makePropertiesStub();
  const env = makeFillEnv({ withGrid: false, extraStubs: { PropertiesService: props.stub } });
  props.stub.getUserProperties().setProperty(env.sandbox.PUBLISH_PREFS_KEY_,
    JSON.stringify({ doPublish: true, doSend: false, groups: ['IT'] }));
  const prefs = env.sandbox.loadPublishPrefs_(['CC']);
  assert.strictEqual(prefs.doPublish, false);
  assert.deepStrictEqual(Array.from(prefs.groups), ['IT']);
});

test('F3-4 偏好讀不到（拋錯）→ 回到預設，doPublish 仍然是 false', function () {
  const env = makeFillEnv({
    withGrid: false,
    extraStubs: { PropertiesService: { getUserProperties: function () { throw new Error('沒有權限'); } } }
  });
  const prefs = env.sandbox.loadPublishPrefs_(['CC', 'DB']);
  assert.strictEqual(prefs.doPublish, false);
  assert.deepStrictEqual(Array.from(prefs.groups), ['CC', 'DB']);
});

test('F3-5 文件已同步：工作表結構說明講明「發佈」不記住', function () {
  const doc = readSrc('docs/工作表結構.md');
  assert.ok(doc.indexOf('永遠以未勾選載入') !== -1);
});

// =====================================================================
// F4：R-046 改名
// =====================================================================

console.log('\nF4：事奉框維持「讀經」，介面欄位叫「讀經經文」');

test('F4-1 介面崇拜程序那一欄叫「讀經經文」', function () {
  const html = readSrc('src/ui/Index.html');
  const m = /<label>([^\n<]+)\n\s*<input type="text" data-field="SCRIPTURE_REF">/.exec(html);
  assert.ok(m, '找不到 SCRIPTURE_REF 的標籤');
  assert.strictEqual(m[1].trim(), '讀經經文');
});

test('F4-2 播種的 PostDisplay：SCRIPTURE 崗位第 1、3 頁名稱都是「讀經」（Word 事奉框印出來的字）', function () {
  const env = makeFillEnv({ withGrid: false });
  const row = env.sandbox.seedPostDisplayRows_().filter(function (r) { return r.POST_ID === 'SCRIPTURE'; })[0];
  assert.strictEqual(row.PAGE1_NAME, '讀經');
  assert.strictEqual(row.PAGE3_NAME, '讀經');
});

test('F4-3 事奉框經 buildDutyBoxRows_() 印出來是「讀經」，沒有括號（第 1、3 頁）', function () {
  const env = makeFillEnv({ withGrid: false });
  const sb = env.sandbox;
  const snapshot = {
    isoDate: D, weekOfMonth: 1, special: null,
    posts: [{ postId: 'SCRIPTURE', nameTC: '讀經', slotCount: 1, frequency: 'WEEKLY', autoGenerate: true, displayOrder: 10, emptyDisplay: 'PENDING' }],
    assignments: [{ postId: 'SCRIPTURE', slotIndex: 1, personId: 'P1', personName: '陳大文', assignSource: 'AUTO', locked: false }]
  };
  snapshot.slotsByPost = sb.buildRosterSlotIndex_(snapshot, [1]);
  [1, 3].forEach(function (page) {
    const rows = sb.buildDutyBoxRows_({
      snapshot: snapshot, page: page, postDisplayRows: sb.seedPostDisplayRows_(),
      mergeGroupRows: sb.seedMergeGroupsRows_(), personDisplayRows: [], withHonorific: false,
      targetDate: sb.normalizeDate_(D), warnings: []
    });
    const labels = rows.map(function (r) { return r.label; });
    assert.ok(labels.indexOf('讀經') !== -1, '第 ' + page + ' 頁應該有「讀經」：' + JSON.stringify(labels));
    assert.ok(labels.every(function (l) { return l.indexOf('事奉') === -1; }), '不可以出現括號：' + JSON.stringify(labels));
  });
});

test('F4-4 使用者看得到的說明不再講「讀經（事奉）」', function () {
  ['src/ContentSheet.gs', 'src/FillGrid.gs', 'src/Bootstrap.gs'].forEach(function (f) {
    extractStringLiterals(readSrc(f)).forEach(function (lit) {
      assert.strictEqual(lit.text.indexOf('讀經（事奉）'), -1, f + ' 第 ' + lit.line + ' 行：' + lit.text);
    });
  });
});

test('F4-5 待確認事項 DD-3 已更正：只剩 ProgramTemplates 一格，並更正表名', function () {
  const doc = readSrc('docs/待確認事項.md');
  const i = doc.indexOf('### DD-3.');
  const section = doc.slice(i, doc.indexOf('### DD-4.'));
  assert.ok(section.indexOf('要人手改的一格') !== -1, section);
  assert.ok(section.indexOf('詩班獻唱') !== -1);
  assert.ok(section.indexOf('PostDisplay') !== -1, '更正說明要點名正確的表名 PostDisplay');
  assert.ok(section.indexOf('不要改') !== -1, '要講明不要改 PostDisplay 那一行');
  // 表格內不再有 PersonDisplay／PostDisplay 的「改成」行。
  const table = section.slice(section.indexOf('| 工作表'), section.indexOf('⚠️ **更正'));
  assert.strictEqual(table.indexOf('PersonDisplay'), -1);
  assert.strictEqual(table.indexOf('PostDisplay'), -1);
});

// =====================================================================
// F6：待填只數「一定要填」
// =====================================================================

console.log('\nF6：待填的數字統一');

function makeWeekEnv(alertSink) {
  return makeFillEnv({
    withGrid: false,
    ui: {
      prompt: function () {
        return { getSelectedButton: function () { return 'OK'; }, getResponseText: function () { return D; } };
      },
      alert: function (title, body) { alertSink.push({ title: title, body: body }); return 'OK'; }
    }
  });
}

test('F6-1 同一週的四個數字相同：頂部徽章、主日下拉、預覽報告、發佈前檢查', function () {
  const alerts = [];
  const env = makeWeekEnv(alerts);
  const sb = env.sandbox;
  const model = sb.buildBulletinModel_(D);
  const expected = sb.splitMissingList_(model.missing).requiredCount;
  const optionalCount = sb.splitMissingList_(model.missing).optional.length;
  assert.ok(expected > 0 && optionalCount > 0, '前提：這一週既有一定要填的、也有通常空白的（獻花）');
  assert.strictEqual(model.missing.length, expected + optionalCount, '前提：missing.length 與只數一定要填是不同的數字');

  // ① 頂部徽章（apiLoadWeek 的 missingSplit）
  const loaded = sb.apiLoadWeek(D);
  assert.strictEqual(loaded.ok, true, JSON.stringify(loaded));
  assert.strictEqual(loaded.data.missingSplit.requiredCount, expected);
  assert.strictEqual(loaded.data.missingSplit.required.length, expected);
  assert.strictEqual(loaded.data.missingSplit.optional.length, optionalCount);

  // ② 主日下拉標籤
  const weeks = sb.listWeeksForWebApp_(false).weeks.filter(function (w) { return w.isoDate === D; })[0];
  assert.strictEqual(weeks.missingCount, expected);
  assert.strictEqual(weeks.statusLabel, '待填 ' + expected + ' 項');

  // ③ 「預覽本週週報資料」（真正的選單入口）：對話框與 Diagnostics 報告
  sb.menuPreviewBulletinModel_();
  assert.strictEqual(alerts.length, 1, JSON.stringify(alerts));
  const suffix = '（另有 ' + optionalCount + ' 項通常空白）';
  assert.ok(alerts[0].body.indexOf('待填項目數：' + expected + suffix) !== -1, alerts[0].body);
  const report = sb.readSheet('Diagnostics').map(function (r) { return r.CONTENT; }).join('\n');
  assert.ok(report.indexOf('【待填清單（' + expected + ' 項）】' + suffix) !== -1, report);
  assert.ok(report.indexOf('〔通常空白〕') !== -1, '通常空白的項目要在清單內標明');

  // ④ 發佈前檢查
  const precheck = sb.buildPublishPrecheck_(D);
  assert.strictEqual(precheck.missingCount, expected);
  assert.ok(precheck.lines.join('\n').indexOf('未填欄位（' + expected + ' 項）' + suffix) !== -1);
});

test('F6-2 missingCountSummary_：沒有通常空白時不附註；空清單是 0', function () {
  const sb = makeFillEnv({ withGrid: false }).sandbox;
  const none = sb.missingCountSummary_([]);
  assert.strictEqual(none.requiredCount, 0);
  assert.strictEqual(none.optionalSuffix, '');
  const onlyRequired = sb.missingCountSummary_([{ field: 'A', label: 'a', optional: false }]);
  assert.strictEqual(onlyRequired.requiredCount, 1);
  assert.strictEqual(onlyRequired.optionalSuffix, '');
  const mixed = sb.missingCountSummary_([{ field: 'A', optional: false }, { field: 'B', optional: true }, { field: 'C', optional: true }]);
  assert.strictEqual(mixed.requiredCount, 1);
  assert.strictEqual(mixed.optionalSuffix, '（另有 2 項通常空白）');
});

test('F6-3 本季待填清單報告：完整列出每一項，並標明是否屬通常空白；彙總數字只數一定要填', function () {
  const env = makeFillEnv({ withGrid: false });
  const sb = env.sandbox;
  const lines = sb.buildQuarterMissingFieldsReportLines_(QUARTER_ID, '測試');
  const flower = lines.filter(function (l) { return l.indexOf('FLOWER_THIS_WEEK') !== -1; });
  assert.ok(flower.length > 0, '獻花也要列出來');
  flower.forEach(function (l) { assert.ok(l.indexOf('〔通常空白〕') !== -1, l); });
  const sermon = lines.filter(function (l) { return l.indexOf('SERMON_TITLE') !== -1; });
  assert.ok(sermon.length > 0);
  sermon.forEach(function (l) { assert.strictEqual(l.indexOf('〔通常空白〕'), -1, l); });

  const summary = sb.selfCheckMissingSummaryByDate_(env.serviceDates.map(function (iso) { return { isoDate: iso }; }));
  const perWeekRequired = env.serviceDates.map(function (iso) {
    return sb.splitMissingList_(sb.buildBulletinModel_(iso).missing).requiredCount;
  }).reduce(function (a, b) { return a + b; }, 0);
  assert.strictEqual(summary.totalMissing, perWeekRequired);
});

test('F6-4 前端不再自己 filter optional（第三份分類）：徽章用伺服器送來的 missingSplit', function () {
  const js = readSrc('src/ui/Script.html');
  const fn = js.slice(js.indexOf('function renderStats('), js.indexOf('function renderWarningsPanel('));
  assert.ok(fn.indexOf('missingSplit') !== -1);
  assert.strictEqual(fn.indexOf('.filter('), -1, 'renderStats 不可以自己再分類');
});

// =====================================================================
// F9：頁內確認對話框
// =====================================================================

console.log('\nF9：頁內確認對話框');

/** 一個最小的假 DOM，剛好夠 openConfirmDialog() 用；用到 innerHTML 就拋錯。 */
function makeFakeDom() {
  const elements = {};
  function makeEl(tag, className) {
    const node = {
      tag: tag, className: className || '', children: [], disabled: false, textContent: '',
      classes: new Set(String(className || '').split(' ').filter(Boolean)),
      focused: false,
      classList: {
        add: function (c) { node.classes.add(c); },
        remove: function (c) { node.classes.delete(c); },
        contains: function (c) { return node.classes.has(c); }
      },
      appendChild: function (child) { node.children.push(child); return child; },
      focus: function () { node.focused = true; elements.__focusedId = node.id; }
    };
    Object.defineProperty(node, 'innerHTML', {
      set: function () { throw new Error('不可以用 innerHTML 塞內容'); },
      get: function () { return ''; }
    });
    return node;
  }
  const document = {
    getElementById: function (id) {
      if (!elements[id]) { elements[id] = makeEl('div'); elements[id].id = id; }
      return elements[id];
    }
  };
  document.getElementById('confirmDialogBackdrop').classList.add('hidden');
  return { document: document, makeEl: makeEl, elements: elements };
}

function loadConfirmDialog() {
  const js = readSrc('src/ui/Script.html');
  const start = js.indexOf('// BEGIN confirm-dialog');
  const end = js.indexOf('// END confirm-dialog');
  assert.ok(start !== -1 && end !== -1, 'Script.html 內找不到 confirm-dialog 區段標記');
  const dom = makeFakeDom();
  const ctx = {
    document: dom.document,
    el: function (tag, className) { return dom.makeEl(tag, className); }
  };
  vm.createContext(ctx);
  vm.runInContext(js.slice(start, end) +
    '\nthis.api = { open: openConfirmDialog, settle: settleConfirmDialog, key: onConfirmDialogKeydown };', ctx);
  return { api: ctx.api, dom: dom };
}

test('F9-1 開啟：標題與內文逐行用 textContent 填入，預設焦點在「取消」', function () {
  const t = loadConfirmDialog();
  const results = [];
  t.api.open('由內容表匯入', ['第一行', '', '<b>不是 HTML</b>'], function (ok) { results.push(ok); });

  const els = t.dom.elements;
  assert.strictEqual(els.confirmDialogTitle.textContent, '由內容表匯入');
  assert.strictEqual(els.confirmDialogBackdrop.classList.contains('hidden'), false, '對話框要顯示出來');
  assert.deepStrictEqual(els.confirmDialogBody.children.map(function (c) { return c.textContent; }),
    ['第一行', '', '<b>不是 HTML</b>'], '每一行一個元素，標籤原樣當文字');
  assert.strictEqual(els.__focusedId, 'confirmCancelBtn', '預設焦點在取消');
  assert.deepStrictEqual(results, [], '還沒有按任何按鈕，不可以有結果');
});

test('F9-2 按「確定」→ 回呼 true，對話框關閉', function () {
  const t = loadConfirmDialog();
  const results = [];
  t.api.open('標題', ['x'], function (ok) { results.push(ok); });
  t.api.settle(true);
  assert.deepStrictEqual(results, [true]);
  assert.strictEqual(t.dom.elements.confirmDialogBackdrop.classList.contains('hidden'), true);
});

test('F9-3 按「取消」或 Esc → 回呼 false（取消就一格都不寫）', function () {
  const t = loadConfirmDialog();
  const results = [];
  t.api.open('標題', ['x'], function (ok) { results.push(ok); });
  t.api.settle(false);
  t.api.open('標題', ['x'], function (ok) { results.push(ok); });
  t.api.key({ key: 'Escape' });
  assert.deepStrictEqual(results, [false, false]);
  assert.strictEqual(t.dom.elements.confirmDialogBackdrop.classList.contains('hidden'), true);
});

test('F9-4 其他按鍵不關閉；沒有對話框時 Esc 什麼都不做', function () {
  const t = loadConfirmDialog();
  const results = [];
  t.api.key({ key: 'Escape' });
  assert.deepStrictEqual(results, []);
  t.api.open('標題', ['x'], function (ok) { results.push(ok); });
  t.api.key({ key: 'Enter' });
  t.api.key({ key: 'a' });
  assert.deepStrictEqual(results, [], 'Enter 不可以等於確定');
  assert.strictEqual(t.dom.elements.confirmDialogBackdrop.classList.contains('hidden'), false);
});

test('F9-5 結果只回呼一次；重複按不會再呼叫', function () {
  const t = loadConfirmDialog();
  let calls = 0;
  t.api.open('標題', ['x'], function () { calls++; });
  t.api.settle(true);
  t.api.settle(true);
  t.api.key({ key: 'Escape' });
  assert.strictEqual(calls, 1);
});

test('F9-6 上一個對話框還開著又開新的 → 上一個當作取消，不會遺失回呼', function () {
  const t = loadConfirmDialog();
  const results = [];
  t.api.open('甲', ['a'], function (ok) { results.push('甲:' + ok); });
  t.api.open('乙', ['b'], function (ok) { results.push('乙:' + ok); });
  t.api.settle(true);
  assert.deepStrictEqual(results, ['甲:false', '乙:true']);
});

test('F9-7 回呼內再開對話框（先確認、再確認）可以正常運作', function () {
  const t = loadConfirmDialog();
  const results = [];
  t.api.open('第一個', ['a'], function (ok) {
    results.push('1:' + ok);
    t.api.open('第二個', ['b'], function (ok2) { results.push('2:' + ok2); });
  });
  t.api.settle(true);
  assert.strictEqual(t.dom.elements.confirmDialogBackdrop.classList.contains('hidden'), false, '第二個要顯示');
  t.api.settle(false);
  assert.deepStrictEqual(results, ['1:true', '2:false']);
});

test('F9-8 兩處原本的 window.confirm 都改了；執行 API 一定排在確認之後', function () {
  const js = readSrc('src/ui/Script.html');
  assert.strictEqual(js.indexOf('window.confirm'), -1);
  assert.strictEqual(/[^.\w]confirm\(/.test(js), false, '連 confirm( 也不可以有');

  const importFn = js.slice(js.indexOf('function onContentImportPreviewed('), js.indexOf('function onContentImportDone('));
  assert.ok(importFn.indexOf('openConfirmDialog(') !== -1);
  assert.ok(importFn.indexOf("callServer('apiRunContentImport'") > importFn.indexOf('openConfirmDialog('));
  assert.ok(importFn.indexOf('已取消，沒有寫入任何資料。') !== -1, '取消時的訊息保留');

  const opFn = js.slice(js.indexOf('function runQuarterOp('), js.indexOf('function runQuarterReport('));
  assert.ok(opFn.indexOf('openConfirmDialog(') !== -1);
  assert.ok(opFn.indexOf('opts.runApi') > opFn.indexOf('openConfirmDialog('));
  // G15：字眼改為共用常數 CANCELLED_NOTHING_WRITTEN_MESSAGE（重設、還原、季度作業同一句）。
  assert.ok(opFn.indexOf("showQuarterOpsMessage('info', CANCELLED_NOTHING_WRITTEN_MESSAGE)") !== -1);
  assert.ok(js.indexOf("var CANCELLED_NOTHING_WRITTEN_MESSAGE = '已取消，一格都沒有寫。';") !== -1);
});

test('F9-9 Index.html 有對話框結構（沿用 dialog-backdrop），預設隱藏，兩粒按鈕字眼正確', function () {
  const html = readSrc('src/ui/Index.html');
  assert.ok(/<div id="confirmDialogBackdrop" class="dialog-backdrop hidden">/.test(html));
  assert.ok(/id="confirmCancelBtn">取消<\/button>/.test(html));
  assert.ok(/id="confirmOkBtn">確定<\/button>/.test(html));
  assert.ok(html.indexOf('id="confirmDialogBody"') !== -1 && html.indexOf('id="confirmDialogTitle"') !== -1);
});

test('F9-10 處理中兩粒按鈕停用、Esc 與按鈕都有接線', function () {
  const js = readSrc('src/ui/Script.html');
  const busy = js.slice(js.indexOf('function applyBusyState('), js.indexOf('function setBusyText('));
  assert.ok(busy.indexOf("getElementById('confirmOkBtn').disabled = busy") !== -1);
  assert.ok(busy.indexOf("getElementById('confirmCancelBtn').disabled = busy") !== -1);
  assert.ok(js.indexOf("addEventListener('keydown', onConfirmDialogKeydown)") !== -1);
  assert.ok(js.indexOf("getElementById('confirmOkBtn').addEventListener('click'") !== -1);
  assert.ok(js.indexOf("getElementById('confirmCancelBtn').addEventListener('click'") !== -1);
});

test('F9-11 .html 註解內沒有樣板標籤符號（見已知 bug 類型第 1 項）', function () {
  ['Index.html', 'Script.html', 'Style.html'].forEach(function (f) {
    const text = readSrc('src/ui/' + f);
    const comments = (text.match(/<!--[\s\S]*?-->/g) || []);
    comments.forEach(function (c) {
      assert.strictEqual(/<\?/.test(c), false, f + ' 的 HTML 註解含有樣板標籤符號：' + c.slice(0, 80));
    });
  });
});

// =====================================================================
// F10：字眼
// =====================================================================

console.log('\nF10：字眼');

test('F10-1 掃描器本身有效（反向鎖）：字串常值內的 ** 抓得到，註解與正規式不算', function () {
  const hits = extractStringLiterals("var a = '**加粗**'; // **註解**\n/* **區塊** */ var b = /a\\*\\*/; var c = `**樣板**`;")
    .filter(function (l) { return l.text.indexOf('**') !== -1; });
  assert.deepStrictEqual(hits.map(function (h) { return h.text; }), ['**加粗**', '**樣板**']);
});

test('F10-1 使用者看得到的字串常值（src/*.gs 與 Script.html 內的 JS）一律不帶 Markdown 的 **', function () {
  const offenders = [];
  fs.readdirSync(path.join(ROOT, 'src')).filter(function (f) { return f.endsWith('.gs'); }).forEach(function (f) {
    extractStringLiterals(readSrc('src/' + f)).forEach(function (lit) {
      if (lit.text.indexOf('**') !== -1) offenders.push(f + ':' + lit.line + '　' + lit.text.slice(0, 60));
    });
  });
  const script = /<script>([\s\S]*)<\/script>/.exec(readSrc('src/ui/Script.html'));
  extractStringLiterals(script[1]).forEach(function (lit) {
    if (lit.text.indexOf('**') !== -1) offenders.push('Script.html　' + lit.text.slice(0, 60));
  });
  ['Index.html', 'FillConflict.html'].forEach(function (f) {
    const visible = readSrc('src/ui/' + f).replace(/<!--[\s\S]*?-->/g, '');
    const withoutScript = visible.replace(/<script>[\s\S]*<\/script>/g, '');
    if (withoutScript.indexOf('**') !== -1) offenders.push(f + ' 的畫面文字');
  });
  assert.deepStrictEqual(offenders, [], '以下字串帶有 **：\n' + offenders.join('\n'));
});

test('F10-1 真正入口的輸出也沒有 **：發佈前檢查、待填報告、預覽報告', function () {
  const env = makeFillEnv({ withGrid: false });
  const sb = env.sandbox;
  const texts = [];
  texts.push(sb.buildPublishPrecheck_(D).lines.join('\n'));
  texts.push(sb.buildQuarterMissingFieldsReportLines_(QUARTER_ID, '測試').join('\n'));
  texts.push(sb.buildBulletinModelReportLines_(sb.buildBulletinModel_(D)).join('\n'));
  texts.forEach(function (t) { assert.strictEqual(t.indexOf('**'), -1, t.slice(0, 200)); });
});

test('F10-2 整季匯入未建立內容表的訊息指向填寫介面（書面語）', function () {
  const env = makeFillEnv({ withGrid: false });
  const sb = env.sandbox;
  const resp = sb.previewContentImport_('2099T1', {});
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.reason, 'NO_CONTENT_SHEET');
  assert.ok(resp.message.indexOf('請先在下面「季度作業」區塊按「建立／刷新本季內容表」。') !== -1, resp.message);
  assert.strictEqual(resp.message.indexOf('選單'), -1);
  assertWrittenChinese(assert, '未建立內容表訊息', resp.message);
});

test('F10-3 預覽頁網址 date 格式不對 → 照樣顯示下一個主日，頁頂加提示（日期是實際值）', function () {
  const env = makeFillEnv({ withGrid: false });
  const sb = env.sandbox;
  const next = sb.resolveNextSendSundayIso_();
  assert.strictEqual(next.ok, true, JSON.stringify(next));

  const resolved = sb.resolvePreviewIsoDate_('abcd');
  assert.strictEqual(resolved.isoDate, next.isoDate, '仍然顯示下一個主日');
  assert.strictEqual(resolved.warning,
    '網址的日期「abcd」格式不正確（應為 YYYY-MM-DD），以下顯示下一個主日 ' + next.isoDate + '。');

  const page = sb.buildPreviewPage_('abcd');
  assert.strictEqual(page.isoDate, next.isoDate);
  assert.ok(page.html.indexOf('網址的日期「abcd」格式不正確（應為 YYYY-MM-DD），以下顯示下一個主日 ' + next.isoDate + '。') !== -1);
  assert.ok(page.html.indexOf('網址的日期') < page.html.indexOf('<h2>'), '提示要在頁頂，排在各區塊之前');
});

test('F10-3 日期合法、或根本沒有帶 date → 沒有提示', function () {
  const sb = makeFillEnv({ withGrid: false }).sandbox;
  assert.strictEqual(sb.resolvePreviewIsoDate_('2027-11-07').warning, '');
  assert.strictEqual(sb.resolvePreviewIsoDate_('').warning, '');
  assert.strictEqual(sb.resolvePreviewIsoDate_(undefined).warning, '');
  assert.strictEqual(sb.buildPreviewPage_('2027-11-07').html.indexOf('格式不正確'), -1);
});

test('F10-3 網址參數先跳脫再顯示：帶標籤的 date 不會變成真的標籤', function () {
  const sb = makeFillEnv({ withGrid: false }).sandbox;
  const evil = '<script>alert(1)</script>';
  const page = sb.buildPreviewPage_(evil);
  assert.strictEqual(page.html.indexOf(evil), -1, '原文不可以原樣出現在 HTML');
  assert.ok(page.html.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;') !== -1);
});

test('F10-3 過長的 date 只顯示頭 40 字', function () {
  const sb = makeFillEnv({ withGrid: false }).sandbox;
  const resolved = sb.resolvePreviewIsoDate_('x'.repeat(200));
  assert.ok(resolved.warning.length < 160, '提示不可以把整串 200 字原樣塞進頁面：' + resolved.warning.length);
  assert.ok(resolved.warning.indexOf('…') !== -1);
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
