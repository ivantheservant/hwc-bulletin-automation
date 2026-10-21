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

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
