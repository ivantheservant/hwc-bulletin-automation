#!/usr/bin/env node
/**
 * tests/stage0.test.js
 *
 * 階段 0（收尾小問題）中屬於前端的部分：
 *   - 成功／資訊／錯誤訊息一律常駐，三種都有「×」，沒有自動消失的計時器；
 *   - 換週（下拉、上一個、下一個、換季）有未儲存改動時要先問一次；
 *   - 單週匯入完成之後主日下拉的標籤即時刷新。
 *
 * 前端函式用「BEGIN／END 標記」從 Script.html 抽出來，在假 DOM 上真的執行。
 *
 * 執行方式：node tests/stage0.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

/** 最小的假 DOM：innerHTML 只准設成空字串（清空），塞內容一律拋錯。 */
function makeFakeDom() {
  const elements = {};
  function makeEl(tag, className) {
    const node = {
      tag: tag, className: className || '', children: [], textContent: '', attrs: {}, listeners: {},
      classes: new Set(String(className || '').split(' ').filter(Boolean)),
      classList: {
        add: function (c) { node.classes.add(c); },
        remove: function (c) { node.classes.delete(c); },
        contains: function (c) { return node.classes.has(c); }
      },
      appendChild: function (child) { node.children.push(child); return child; },
      setAttribute: function (k, v) { node.attrs[k] = v; },
      addEventListener: function (type, fn) { node.listeners[type] = fn; },
      focus: function () {}
    };
    Object.defineProperty(node, 'innerHTML', {
      set: function (v) {
        if (v !== '') throw new Error('不可以用 innerHTML 塞內容');
        node.children = [];
      },
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
  return { document: document, makeEl: makeEl, elements: elements };
}

function extract(js, name) {
  const start = js.indexOf('// BEGIN ' + name);
  const end = js.indexOf('// END ' + name);
  assert.ok(start !== -1 && end !== -1, 'Script.html 內找不到 ' + name + ' 區段標記');
  return js.slice(start, end);
}

// =====================================================================
// 0.5 訊息常駐
// =====================================================================

console.log('\n訊息條常駐');

function loadMessageBar() {
  const js = readSrc('src/ui/Script.html');
  const dom = makeFakeDom();
  const timers = [];
  const ctx = {
    document: dom.document,
    el: function (tag, className) { return dom.makeEl(tag, className); },
    setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
    clearTimeout: function () {}
  };
  vm.createContext(ctx);
  vm.runInContext(extract(js, 'message-bar') + '\nthis.api = { show: showMessage, hide: hideMessage };', ctx);
  return { api: ctx.api, dom: dom, timers: timers };
}

['success', 'info', 'error'].forEach(function (type) {
  test('訊息類型 ' + type + '：有「×」、沒有計時器、不會自己消失', function () {
    const t = loadMessageBar();
    t.api.show(type, '訊息內容');
    const bar = t.dom.elements.messageBar;
    assert.strictEqual(bar.classes.has('hidden'), false, '要顯示出來');
    assert.ok(bar.className.indexOf(type) !== -1);
    assert.strictEqual(bar.children.length, 2, '一個文字、一個「×」');
    assert.strictEqual(bar.children[0].textContent, '訊息內容');
    const close = bar.children[1];
    assert.strictEqual(close.textContent, '×');
    assert.strictEqual(close.attrs['aria-label'], '關閉');
    assert.strictEqual(t.timers.length, 0, '不可以設任何自動消失的計時器');

    close.listeners.click();
    assert.strictEqual(bar.classes.has('hidden'), true, '按「×」要收起');
  });
});

test('訊息文字用 textContent（標籤原樣當文字），舊的自動消失常數已刪除', function () {
  const t = loadMessageBar();
  t.api.show('info', '<b>不是 HTML</b>');
  assert.strictEqual(t.dom.elements.messageBar.children[0].textContent, '<b>不是 HTML</b>');
  const js = readSrc('src/ui/Script.html');
  assert.strictEqual(js.indexOf('MESSAGE_MIN_VISIBLE_MS'), -1);
  assert.strictEqual(js.indexOf('messageAutoHideTimer'), -1);
});

// =====================================================================
// 0.6 換週保護
// =====================================================================

console.log('\n換週保護');

function loadGuard(stateOverrides, formFields) {
  const js = readSrc('src/ui/Script.html');
  const dialogs = [];
  const ctx = {
    state: Object.assign({
      loaded: true, loadedWeek: { PRELUDE: '甲', SERMON_TITLE: '講題' },
      dutyEdits: {}, nextWeekDutyEdits: {}, loadedDutyNames: {}, loadedNextDutyNames: {}
    }, stateOverrides || {}),
    CONTENT_SHEET_WEEK_FIELDS: ['CALL_REF'],
    collectWeekFieldsFromForm: function () {
      return Object.assign({ PRELUDE: '甲', SERMON_TITLE: '講題', CALL_REF: '' }, formFields || {});
    },
    openConfirmDialog: function (title, lines, cb) { dialogs.push({ title: title, lines: lines, cb: cb }); }
  };
  vm.createContext(ctx);
  vm.runInContext(extract(js, 'week-diff') + '\n' + extract(js, 'week-switch-guard')
    + '\nthis.api = { dirty: hasUnsavedWeekChanges, confirm: confirmWeekChange, names: dutyNameMap };', ctx);
  return { api: ctx.api, dialogs: dialogs, state: ctx.state };
}

test('沒有改動 → 不問、直接換週', function () {
  const t = loadGuard();
  let proceeded = 0;
  t.api.confirm(function () { proceeded++; }, function () { throw new Error('不應該取消'); });
  assert.strictEqual(proceeded, 1);
  assert.strictEqual(t.dialogs.length, 0);
});

test('表單欄位有改動 → 先問；確定才換週，取消就留在原週', function () {
  const t = loadGuard({}, { SERMON_TITLE: '新講題' });
  assert.strictEqual(t.api.dirty(), true);
  const log = [];
  t.api.confirm(function () { log.push('proceed'); }, function () { log.push('revert'); });
  assert.strictEqual(t.dialogs.length, 1);
  assert.strictEqual(t.dialogs[0].title, '換週');
  assert.deepStrictEqual(Array.from(t.dialogs[0].lines), ['這一週有未儲存的改動，換週會丟失這些改動。確定要換週嗎？']);
  assert.deepStrictEqual(log, [], '還沒有按任何按鈕');
  t.dialogs[0].cb(false);
  assert.deepStrictEqual(log, ['revert']);

  t.api.confirm(function () { log.push('proceed'); }, function () { log.push('revert'); });
  t.dialogs[1].cb(true);
  assert.deepStrictEqual(log, ['revert', 'proceed']);
});

test('內容表接管的欄位不算「未儲存的改動」（儲存本來就不送它們）', function () {
  const t = loadGuard({}, { CALL_REF: '被匯入改過' });
  assert.strictEqual(t.api.dirty(), false);
});

test('事奉框改名（本週／下週）都算改動；改了又改回來不算', function () {
  const t = loadGuard({
    dutyEdits: { 'P1#0': { postId: 'P1', slotIndex: 0, name: '甲' } },
    loadedDutyNames: { 'P1#0': '甲' },
    nextWeekDutyEdits: { 'P2#0': { postId: 'P2', slotIndex: 0, name: '乙' } },
    loadedNextDutyNames: { 'P2#0': '乙' }
  });
  assert.strictEqual(t.api.dirty(), false, '剛載入，沒有改動');

  t.state.dutyEdits['P1#0'].name = '丙';
  assert.strictEqual(t.api.dirty(), true, '本週事奉框改名');
  t.state.dutyEdits['P1#0'].name = '甲';
  assert.strictEqual(t.api.dirty(), false, '改回原值就不算');

  t.state.nextWeekDutyEdits['P2#0'].name = '丁';
  assert.strictEqual(t.api.dirty(), true, '下週事奉框改名');
});

test('資料還沒載入成功（state.loaded 為 false）→ 不攔換週', function () {
  const t = loadGuard({ loaded: false }, { SERMON_TITLE: '亂改' });
  assert.strictEqual(t.api.dirty(), false);
});

test('接線：下拉、上一個／下一個、換季都經 confirmWeekChange；取消時兩個下拉改回目前這一週；沒有 window.confirm', function () {
  const js = readSrc('src/ui/Script.html');
  assert.ok(js.indexOf("addEventListener('change', function (e) { onWeekSelectChanged(e.target.value); })") !== -1);
  const step = js.slice(js.indexOf('function stepWeek('), js.indexOf('function onWeekSelectChanged('));
  assert.ok(step.indexOf('confirmWeekChange(') !== -1);
  assert.ok(step.indexOf('syncSelectorsTo(state.isoDate)') !== -1);
  const quarter = js.slice(js.indexOf('function onQuarterChanged('), js.indexOf('R-036：職事表未有資料的黃色橫幅'));
  assert.ok(quarter.indexOf('confirmWeekChange(') !== -1);
  assert.ok(quarter.indexOf('syncSelectorsTo(state.isoDate)') !== -1);
  assert.strictEqual(js.indexOf('window.confirm'), -1);
  // 載入完成後要記下兩個事奉框載入時的名字
  const loaded = js.slice(js.indexOf('function onWeekLoaded('), js.indexOf('function renderFillGridLink('));
  assert.ok(loaded.indexOf('state.loadedDutyNames = dutyNameMap(state.dutyEdits)') !== -1);
  assert.ok(loaded.indexOf('state.loadedNextDutyNames = dutyNameMap(state.nextWeekDutyEdits)') !== -1);
});

// =====================================================================
// 0.3 單週匯入完成之後刷新主日下拉標籤
// =====================================================================

console.log('\n單週匯入之後刷新下拉標籤');

test('onContentImportDone：成功訊息不被 loadWeek 清走，而且刷新主日下拉標籤', function () {
  const js = readSrc('src/ui/Script.html');
  const fn = js.slice(js.indexOf('function onContentImportDone('), js.indexOf('function applyBaptismPanelVisibility('));
  assert.ok(fn.indexOf('loadWeek(state.isoDate, { keepMessage: true })') !== -1);
  assert.ok(fn.indexOf('refreshWeekSelectorLabels()') !== -1);
});


// =====================================================================
// 第二批測試修正 G3：換週之後，發佈區不可以仍然掛著上一週的結果
// =====================================================================

console.log('\n換週之後收起發佈區的結果（G3）');

/** 有 classList.toggle 的最小假元素（showPublishResult 要用）。 */
function makeResultBox() {
  const classes = new Set(['publish-result', 'hidden']);
  return {
    textContent: '',
    classes: classes,
    classList: {
      add: function (c) { classes.add(c); },
      remove: function (c) { classes.delete(c); },
      contains: function (c) { return classes.has(c); },
      toggle: function (c, force) {
        const on = force === undefined ? !classes.has(c) : Boolean(force);
        if (on) classes.add(c); else classes.delete(c);
        return on;
      }
    }
  };
}

/**
 * 抽出 publish-result、load-week 兩段，加上「下一個 →」的 stepWeek()，在假環境
 * 執行。callServer 的替身即時回應成功，並照 onWeekLoaded() 的做法更新 state.isoDate。
 */
function loadPublishResultRegion(startIsoDate, options) {
  const o = options || {};
  const js = readSrc('src/ui/Script.html');
  const box = makeResultBox();
  const calls = { hideMessage: 0, server: [], messages: [], confirmErrors: [], readers: [] };
  const weeks = [{ isoDate: '2028-04-02' }, { isoDate: '2028-04-09' }, { isoDate: '2028-04-16' }];
  // G9：發佈區塊用到的其他元素（檔案選擇框、檔名、兩個勾選、自訂電郵）。
  const elements = {
    publishResult: box,
    publishPdfInput: { value: '' },
    publishPdfName: { textContent: '未選擇' },
    doPublishCheck: { checked: false },
    doSendCheck: { checked: false },
    publishCustomEmails: { value: '' },
    // v3：寄出時「一併附上最新已儲存的 Word 檔」。
    attachWordCheck: { checked: false }
  };
  /** 假 FileReader：`deferred` 時要測試自己呼叫 `finish()`，模擬讀檔比換週慢。 */
  function FakeFileReader() {
    const reader = this;
    reader.result = null;
    reader.readAsDataURL = function (file) {
      reader.finish = function () {
        reader.result = 'data:application/pdf;base64,' + file.__base64;
        reader.onload();
      };
      calls.readers.push(reader);
      if (!o.deferredRead) reader.finish();
    };
  }
  const ctx = {
    state: {
      isoDate: startIsoDate, loaded: true,
      publish: { pdfBase64: '', pdfName: '', pdfIsoDate: '', panel: { maxPdfMb: 10 }, confirmButton: '' }
    },
    document: {
      getElementById: function (id) {
        if (!elements[id]) throw new Error('未預期的元素 ' + id);
        return elements[id];
      }
    },
    FileReader: FakeFileReader,
    hideMessage: function () { calls.hideMessage++; },
    showMessage: function (type, text) { calls.messages.push({ type: type, text: text }); },
    showPublishConfirmError: function (text) { calls.confirmErrors.push(text); },
    setPublishButtonsBusy: function () {},
    selectedPublishGroups: function () { return ['IT']; },
    onPublishDone: function () {},
    setLoaded: function () {},
    flatWeeksInOrder: function () { return weeks; },
    syncSelectorsTo: function () {},
    confirmWeekChange: function (proceed) { proceed(); },
    callServer: function (name, args, onOk) {
      calls.server.push({ name: name, args: args });
      onOk({ ok: true, data: {} });
    },
    onWeekLoaded: function (isoDate) { ctx.state.isoDate = isoDate; }
  };
  vm.createContext(ctx);
  const step = js.slice(js.indexOf('function stepWeek('), js.indexOf('function onWeekSelectChanged('));
  vm.runInContext(extract(js, 'publish-result') + '\n' + extract(js, 'load-week') + '\n' + step
    + '\n' + extract(js, 'publish-run')
    + '\nthis.api = { show: showPublishResult, clear: clearPublishResult, loadWeek: loadWeek, stepWeek: stepWeek,'
    + ' choosePdf: onPublishPdfChosen, runPublish: runPublish, weekChangedMessage: PUBLISH_PDF_WEEK_CHANGED_MESSAGE };', ctx);
  return { api: ctx.api, box: box, state: ctx.state, calls: calls, elements: elements };
}

const G3_RESULT = '⚠️ 模擬模式開啟中：已記錄 1 個收件人，但沒有真的寄出。\n\n（本次是在確認「仍然要寄出」之後執行的。）';

test('G3-1 04-09 只寄出之後按「下一個 →」到 04-16（經 stepWeek → loadWeek）→ #publishResult 清空並有 hidden', function () {
  const t = loadPublishResultRegion('2028-04-09');
  t.api.show(G3_RESULT, false);
  assert.strictEqual(t.box.classes.has('hidden'), false, '前提：結果正在顯示');

  t.api.stepWeek(1);
  assert.strictEqual(t.calls.server.length, 1);
  assert.strictEqual(t.calls.server[0].name, 'apiLoadWeek');
  assert.strictEqual(t.calls.server[0].args[0], '2028-04-16');
  assert.strictEqual(t.state.isoDate, '2028-04-16');
  assert.strictEqual(t.box.classes.has('hidden'), true, '換到另一個主日要收起上一週的結果');
  assert.strictEqual(t.box.textContent, '', '內容要清空，不可以只是收起');
});

test('G3-2 同一個主日重新載入（發佈、還原之後 loadWeek(state.isoDate, {keepMessage:true})）→ 結果保留', function () {
  const t = loadPublishResultRegion('2028-04-09');
  t.api.show(G3_RESULT, false);
  t.api.loadWeek('2028-04-09', { keepMessage: true });
  assert.strictEqual(t.box.classes.has('hidden'), false, '同一個主日重新載入不可以清走剛顯示的結果');
  assert.strictEqual(t.box.textContent, G3_RESULT);
  assert.strictEqual(t.calls.hideMessage, 0);

  // 不帶 keepMessage 的同日重載（例如重新選同一個主日）一樣保留——結果跟主日走。
  t.api.loadWeek('2028-04-09');
  assert.strictEqual(t.box.classes.has('hidden'), false);
});

test('G3-3 錯誤結果（紅色）換週之後一併收起，紅色樣式也清走；第一次載入（沒有上一個主日）不會出錯', function () {
  const t = loadPublishResultRegion('2028-04-16');
  t.api.show('未能執行。', true);
  assert.strictEqual(t.box.classes.has('is-error'), true);
  t.api.loadWeek('2028-04-02');
  assert.strictEqual(t.box.classes.has('hidden'), true);
  assert.strictEqual(t.box.classes.has('is-error'), false);

  const first = loadPublishResultRegion(null);
  assert.doesNotThrow(function () { first.api.loadWeek('2028-04-09'); });
  assert.strictEqual(first.box.classes.has('hidden'), true);
});


// =====================================================================
// 第二批測試修正 G9：換週之後，已選的 PDF 不可以拿去發佈另一週
// =====================================================================

console.log('\n換週之後清走已選的 PDF（G9）');

/** 模擬在檔案選擇框揀了一個 PDF。 */
function pickPdf(t, name, base64) {
  t.elements.publishPdfInput.value = 'C:\\fakepath\\' + name;
  t.api.choosePdf({ target: { files: [{ name: name, size: 1000, __base64: base64 }], value: t.elements.publishPdfInput.value } });
}

/** 取出送去 apiRunPublish 的請求（沒有就是 undefined）。 */
function publishCalls(t) {
  return t.calls.server.filter(function (c) { return c.name === 'apiRunPublish'; });
}

test('G9-1 04-09 揀了 PDF 之後按「下一個 →」到 04-16（經 stepWeek → loadWeek）→ 已選的 PDF 清走、檔案選擇框清空、顯示「未選擇」；勾發佈按執行不會帶上一週的 PDF', function () {
  const t = loadPublishResultRegion('2028-04-09');
  pickPdf(t, '2028-04-09_週報.pdf', 'QUFBQQ==');
  assert.strictEqual(t.state.publish.pdfBase64, 'QUFBQQ==', '前提：PDF 已讀入');
  assert.strictEqual(t.state.publish.pdfIsoDate, '2028-04-09', '要記下揀檔時的主日');
  assert.strictEqual(t.elements.publishPdfName.textContent, '2028-04-09_週報.pdf');

  t.api.stepWeek(1);
  assert.strictEqual(t.state.isoDate, '2028-04-16');
  assert.strictEqual(t.state.publish.pdfBase64, '');
  assert.strictEqual(t.state.publish.pdfName, '');
  assert.strictEqual(t.state.publish.pdfIsoDate, '');
  assert.strictEqual(t.elements.publishPdfInput.value, '', '不清空的話，再揀同一個檔案不會觸發 change');
  assert.strictEqual(t.elements.publishPdfName.textContent, '未選擇');

  t.elements.doPublishCheck.checked = true;
  t.api.runPublish(false);
  assert.strictEqual(publishCalls(t).length, 0, '一個發佈請求都不可以送出');
  assert.ok(t.calls.messages.some(function (m) { return m.type === 'error' && m.text.indexOf('尚未選擇 PDF 檔案') !== -1; }),
    JSON.stringify(t.calls.messages));
});

test('G9-2 同一主日重新載入（儲存、還原、重設、補抓之後 loadWeek(state.isoDate, {keepMessage:true})）→ 已選的 PDF 保留，可以照常發佈這一週', function () {
  const t = loadPublishResultRegion('2028-04-09');
  pickPdf(t, '2028-04-09_週報.pdf', 'QUFBQQ==');
  t.api.loadWeek('2028-04-09', { keepMessage: true });
  assert.strictEqual(t.state.publish.pdfBase64, 'QUFBQQ==');
  assert.strictEqual(t.elements.publishPdfName.textContent, '2028-04-09_週報.pdf');

  t.elements.doPublishCheck.checked = true;
  t.api.runPublish(false);
  const sent = publishCalls(t);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].args[0].isoDate, '2028-04-09');
  assert.strictEqual(sent[0].args[0].pdfBase64, 'QUFBQQ==');
  assert.strictEqual(sent[0].args[0].doPublish, true);
});

test('G9-3 競態：揀檔之後、讀完之前換了主日 → 讀完時丟棄，畫面維持「未選擇」，發佈不會帶那個 PDF', function () {
  const t = loadPublishResultRegion('2028-04-09', { deferredRead: true });
  pickPdf(t, '2028-04-09_週報.pdf', 'QkJCQg==');
  assert.strictEqual(t.calls.readers.length, 1, '前提：讀檔仍在進行');
  t.api.stepWeek(1);
  t.calls.readers[0].finish();

  assert.strictEqual(t.state.isoDate, '2028-04-16');
  assert.strictEqual(t.state.publish.pdfBase64, '', '換週之後才讀完的 PDF 不屬於這一週');
  assert.strictEqual(t.elements.publishPdfName.textContent, '未選擇');
  t.elements.doPublishCheck.checked = true;
  t.api.runPublish(false);
  assert.strictEqual(publishCalls(t).length, 0);
});

test('G9-4 第二道防線：state 裏面的 PDF 是另一個主日揀的 → runPublish 拒絕，訊息列與確認視窗都顯示「選了檔案之後換了主日，請重新選這一週的 PDF。」；只寄出不受影響', function () {
  const t = loadPublishResultRegion('2028-04-16');
  t.state.publish.pdfBase64 = 'Q0NDQw==';
  t.state.publish.pdfName = '2028-04-09_週報.pdf';
  t.state.publish.pdfIsoDate = '2028-04-09';

  t.elements.doPublishCheck.checked = true;
  t.api.runPublish(true);
  assert.strictEqual(publishCalls(t).length, 0);
  assert.strictEqual(t.api.weekChangedMessage, '選了檔案之後換了主日，請重新選這一週的 PDF。');
  assert.ok(t.calls.messages.some(function (m) { return m.type === 'error' && m.text === '選了檔案之後換了主日，請重新選這一週的 PDF。'; }));
  assert.deepStrictEqual(t.calls.confirmErrors, ['選了檔案之後換了主日，請重新選這一週的 PDF。'], '確認視窗是 modal，視窗內也要寫');

  // 只寄出（不發佈）不用 PDF，不擋。
  t.elements.doPublishCheck.checked = false;
  t.elements.doSendCheck.checked = true;
  t.api.runPublish(false);
  const sent = publishCalls(t);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].args[0].pdfBase64, '', '只寄出不送 PDF');
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
