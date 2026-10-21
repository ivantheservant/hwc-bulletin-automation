#!/usr/bin/env node
/**
 * tests/writeaction.test.js
 *
 * 第二批測試修正 G13：寫入類動作遇到連線錯誤（例如 HTTP 502）時，訊息改講「這個動作
 * 可能已經完成」，等一會之後自動重新載入同一個主日（保留訊息、不觸發換週清理）。
 * 伺服器明確回傳的錯誤與讀取類動作的失敗照舊。
 *
 * 前端函式用「BEGIN／END 標記」與函式名稱從 Script.html 抽出來，在假 DOM 上真的
 * 執行；google.script.run 用假替身，由測試決定成功或失敗。一律經真正入口：按鈕的
 * click 事件由真正的 wireStaticEvents()／wireQuarterOpsEvents() 接上，還原按鈕由
 * 真正的 renderSnapshotList() 畫出來。
 *
 * 執行方式：node tests/writeaction.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
}

const D = '2028-04-09';
const NETWORK_502 = 'NetworkError: Connection failure due to HTTP 502';

// =====================================================================
// 假 DOM、假計時器、假 google.script.run
// =====================================================================

/** 最小的假 DOM：getElementById 找不到就自動建立；innerHTML 設定時清走子元素。 */
function makeFakeDom() {
  const elements = {};
  const docListeners = {};
  function makeEl(tag, className) {
    const classes = new Set(String(className || '').split(' ').filter(Boolean));
    const node = {
      tag: tag, children: [], textContent: '', value: '', checked: false, disabled: false,
      type: '', open: false, attrs: {}, listeners: {},
      classList: {
        add: function (c) { classes.add(c); },
        remove: function (c) { classes.delete(c); },
        contains: function (c) { return classes.has(c); },
        toggle: function (c, force) {
          const on = force === undefined ? !classes.has(c) : Boolean(force);
          if (on) classes.add(c); else classes.delete(c);
          return on;
        }
      },
      appendChild: function (child) { node.children.push(child); return child; },
      setAttribute: function (k, v) { node.attrs[k] = String(v); },
      getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(node.attrs, k) ? node.attrs[k] : null; },
      removeAttribute: function (k) { delete node.attrs[k]; },
      hasAttribute: function (k) { return Object.prototype.hasOwnProperty.call(node.attrs, k); },
      addEventListener: function (type, fn) { node.listeners[type] = fn; },
      focus: function () {}
    };
    Object.defineProperty(node, 'className', {
      get: function () { return Array.from(classes).join(' '); },
      set: function (v) { classes.clear(); String(v || '').split(' ').filter(Boolean).forEach(function (c) { classes.add(c); }); }
    });
    Object.defineProperty(node, 'innerHTML', {
      get: function () { return node._html || ''; },
      set: function (v) { node._html = String(v); node.children = []; }
    });
    return node;
  }
  const document = {
    getElementById: function (id) {
      if (!elements[id]) { elements[id] = makeEl('div'); elements[id].id = id; }
      return elements[id];
    },
    addEventListener: function (type, fn) { docListeners[type] = fn; },
    querySelectorAll: function () { return []; }
  };
  return { document: document, makeEl: makeEl, elements: elements, docListeners: docListeners };
}

/** 假計時器：只記下，由測試決定甚麼時候執行。 */
function makeFakeTimers() {
  const timers = [];
  return {
    timers: timers,
    setTimeout: function (fn, ms) { timers.push({ id: timers.length + 1, fn: fn, ms: ms, done: false }); return timers.length; },
    clearTimeout: function (id) { const t = timers[id - 1]; if (t) t.done = true; },
    /** 執行所有未執行、而且延遲剛好是 ms 的計時器；回傳執行了幾個。 */
    run: function (ms) {
      let n = 0;
      timers.slice().forEach(function (t) {
        if (t.done || t.ms !== ms) return;
        t.done = true;
        n++;
        t.fn();
      });
      return n;
    },
    pending: function (ms) { return timers.filter(function (t) { return !t.done && t.ms === ms; }).length; }
  };
}

/** 假 google.script.run：每一個呼叫記下來，由測試呼叫 ok()／fail()。 */
function makeFakeGoogle(calls) {
  function newRunner() {
    const handlers = {};
    const runner = new Proxy({}, {
      get: function (target, prop) {
        if (prop === 'withSuccessHandler') return function (fn) { handlers.ok = fn; return runner; };
        if (prop === 'withFailureHandler') return function (fn) { handlers.fail = fn; return runner; };
        return function () {
          calls.push({
            name: String(prop), args: Array.prototype.slice.call(arguments), taken: false,
            ok: function (resp) { handlers.ok(resp); },
            fail: function (err) { handlers.fail(err); }
          });
        };
      }
    });
    return runner;
  }
  return { script: { get run() { return newRunner(); } } };
}

// =====================================================================
// 把 Script.html 的相關片段抽出來
// =====================================================================

function region(js, name) {
  const start = js.indexOf('// BEGIN ' + name);
  const end = js.indexOf('// END ' + name);
  assert.ok(start !== -1 && end !== -1, 'Script.html 內找不到 ' + name + ' 區段標記');
  return js.slice(start, end);
}

function between(js, from, to) {
  const start = js.indexOf(from);
  const end = js.indexOf(to, start);
  assert.ok(start !== -1 && end !== -1, 'Script.html 內找不到 ' + from + ' 至 ' + to);
  return js.slice(start, end);
}

/**
 * 建立一個「已載入 D、可以操作」的填寫介面。真正的程式碼包括：訊息列、忙碌狀態、
 * callServer() 與 G13 的補救、確認對話框、版本記錄的還原與重設、講員表格的建立、
 * loadWeek()、儲存、發佈、季度作業、wireStaticEvents()。其餘函式用記錄呼叫的替身。
 */
function makeUi() {
  const js = readSrc('src/ui/Script.html');
  const dom = makeFakeDom();
  const timers = makeFakeTimers();
  const calls = [];
  const log = { weekLoaded: [], selectorLabels: 0, publishPanel: 0, speakerStatus: 0, quarterOpsPanel: 0 };
  const ctx = {
    console: console,
    google: makeFakeGoogle(calls),
    document: dom.document,
    window: {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    el: function (tag, className) { return dom.makeEl(tag, className); },
    escapeHtml: function (t) { return String(t); },
    state: {
      isoDate: D, showArchived: false, quarters: [], quarterId: '2028T2', lastSavedAt: '2026-10-22 09:00:00',
      loaded: true, inFlight: 0, previewInFlight: 0, week: {}, loadedWeek: {}, snapshotsLoadedFor: null,
      speakerForm: null, fetchCandidates: [],
      quarterOps: { quarterId: '2028T2', dryRun: true },
      publish: { pdfBase64: '', pdfName: '', pdfIsoDate: '', panel: { maxPdfMb: 10 }, confirmButton: '' }
    },
    // ---- 替身：只記錄有沒有被叫 ----
    onWeekLoaded: function (isoDate) { log.weekLoaded.push(isoDate); ctx.state.isoDate = isoDate; ctx.setLoaded(true); },
    refreshWeekSelectorLabels: function () { log.selectorLabels++; },
    loadPublishPanel: function () { log.publishPanel++; },
    loadSpeakerFormStatus: function () { log.speakerStatus++; },
    refreshQuarterOpsPanel: function () { log.quarterOpsPanel++; },
    buildSavePayload: function () { return { isoDate: ctx.state.isoDate, lastSavedAt: ctx.state.lastSavedAt, week: { PRELUDE: '新序樂' }, baseWeek: { PRELUDE: '' } }; },
    hasUnsavedWeekChanges: function () { return false; },
    selectedPublishGroups: function () { return ['ADMIN']; },
    openPublishConfirm: function () {},
    closePublishConfirm: function () {},
    isSnapshotPanelOpen: function () { return false; },
    loadSnapshotPanel: function () {},
    onWeekSelectChanged: function () {}, onQuarterChanged: function () {}, onShowArchivedChanged: function () {},
    stepWeek: function () {}, backfillRoster: function () {}, reloadRosterOnly: function () {},
    openFetchFromRosterDialog: function () {}, closeFetchDialog: function () {}, confirmFetchFromRoster: function () {},
    setAllFetchCheckboxes: function () {}, applyPublishSubStates: function () {}, savePublishPrefs: function () {},
    downloadWord: function () {}, onSpeakerFormCopyClicked: function () {}, renderFlowerHints: function () {},
    schedulePreviewRefresh: function () {}, toggleQuarterOps: function () {}
  };
  vm.createContext(ctx);
  const code = [
    region(js, 'message-bar'),
    between(js, 'function setLoaded(', '// BEGIN call-server'),
    region(js, 'call-server'),
    region(js, 'confirm-dialog'),
    region(js, 'snapshot-panel'),
    between(js, 'function onSnapshotRestoreClicked(', '// BEGIN speaker-form'),
    region(js, 'speaker-form'),
    between(js, 'function onSpeakerFormCreateClicked(', 'function onSpeakerFormCopyClicked('),
    region(js, 'load-week'),
    between(js, 'function setSaveButtonText(', 'function refreshWeekSelectorLabels('),
    region(js, 'publish-run'),
    between(js, 'function setPublishButtonsBusy(', '// BEGIN publish-result'),
    region(js, 'publish-result'),
    between(js, 'function wireStaticEvents(', 'function toggleQuarterOps('),
    between(js, 'function showQuarterOpsMessage(', 'function wireGlobalErrorHandlers(')
  ].join('\n');
  vm.runInContext(code, ctx);
  dom.document.getElementById('confirmDialogBackdrop').classList.add('hidden');
  ctx.wireStaticEvents();
  ctx.applyBusyState();

  const els = dom.elements;
  return {
    ctx: ctx, els: els, timers: timers, calls: calls, log: log, dom: dom,
    delayMs: ctx.NO_RESPONSE_RELOAD_DELAY_MS,
    click: function (id) {
      const node = dom.document.getElementById(id);
      assert.ok(node.listeners.click, '#' + id + ' 沒有接上 click');
      node.listeners.click({ target: node });
    },
    /** 取出下一個未處理、名稱是 name 的伺服器呼叫。 */
    take: function (name) {
      const c = calls.filter(function (x) { return x.name === name && !x.taken; })[0];
      assert.ok(c, '沒有送出 ' + name + '；已送出：' + calls.map(function (x) { return x.name; }).join('、'));
      c.taken = true;
      return c;
    },
    count: function (name) { return calls.filter(function (x) { return x.name === name; }).length; },
    message: function () {
      const bar = els.messageBar;
      if (!bar || bar.classList.contains('hidden') || bar.children.length === 0) return null;
      return { type: bar.className.replace('message-bar', '').trim(), text: bar.children[0].textContent };
    }
  };
}

/** 經真正的 renderSnapshotList() 畫一個版本，按它的「還原到這個版本」。 */
function clickRestoreButton(ui, snapshotId) {
  const list = ui.dom.document.getElementById('snapshotList');
  ui.ctx.renderSnapshotList(list, [{ snapshotId: snapshotId, createdAt: '2026-10-22 08:00', createdBy: 'ivan', reasonLabel: '填寫介面儲存', summary: '' }], {
    onDiff: ui.ctx.onSnapshotDiffClicked || function () {},
    onRestore: ui.ctx.onSnapshotRestoreClicked
  });
  const buttons = list.children[0].children.filter(function (c) { return c.className === 'snapshot-buttons'; })[0];
  const restoreBtn = buttons.children.filter(function (b) { return b.textContent === '還原到這個版本'; })[0];
  restoreBtn.listeners.click();
}

const DIFF_OK = { ok: true, data: { createdAt: '2026-10-22 08:00', reasonLabel: '填寫介面儲存', rows: [], noteLine: '還原前會先自動存一個版本。', lastSavedAt: '2026-10-22 09:00:00' } };

function expectedWeekMessage(fnName) {
  return '伺服器沒有回應（' + fnName + '），這個動作可能已經完成。系統已重新載入這一個主日，請先看「最後儲存時間」和「版本記錄」，確認未完成才再做一次。';
}

/** 斷言：apiLogClientError 收到原本的錯誤內容，加上「（連線錯誤，動作可能已完成）」。 */
function assertReportedAsNoResponse(ui, fnName, rawFragment) {
  const reports = ui.calls.filter(function (c) { return c.name === 'apiLogClientError'; });
  assert.strictEqual(reports.length, 1, '要即時回報一次 ErrorLog');
  const payload = reports[0].args[0];
  assert.strictEqual(payload.functionName, fnName);
  assert.ok(payload.message.indexOf('呼叫伺服器失敗（' + fnName + '）：') === 0, payload.message);
  assert.ok(payload.message.indexOf(rawFragment) !== -1, '要保留原本的錯誤內容：' + payload.message);
  assert.ok(payload.message.endsWith('（連線錯誤，動作可能已完成）'), payload.message);
}

// =====================================================================
// G13：寫入類動作遇到連線錯誤
// =====================================================================

console.log('\n寫入類動作遇到連線錯誤（G13）');

test('G13-1 按「儲存」→ apiSaveWeek 收到 HTTP 502：即時回報 ErrorLog；等候期間介面忙碌、不可以再按；時間到出新訊息，重新載入同一主日並保留訊息，發佈區不被換週清理', function () {
  const ui = makeUi();
  // 前提：發佈區有這一週的結果與已選的 PDF（G3／G9 的換週清理不可以清走）。
  ui.ctx.showPublishResult('已發佈第 3 版。', false);
  Object.assign(ui.ctx.state.publish, { pdfBase64: 'QUFB', pdfName: '週報.pdf', pdfIsoDate: D });

  ui.click('saveBtn');
  ui.take('apiSaveWeek').fail(new Error(NETWORK_502));

  assertReportedAsNoResponse(ui, 'apiSaveWeek', 'HTTP 502');
  assert.strictEqual(ui.message(), null, '等候期間還未講「已重新載入」');
  assert.strictEqual(ui.ctx.state.inFlight, 1, '等候期間介面維持忙碌');
  assert.strictEqual(ui.els.saveBtn.disabled, true, '等候期間不可以再按「儲存」');
  assert.ok(ui.els.busyBarText.textContent.indexOf('伺服器沒有回應') === 0, ui.els.busyBarText.textContent);
  assert.strictEqual(ui.count('apiLoadWeek'), 0, '未等完不可以重新載入');

  // 再按一次「儲存」也不會送出（logic 層的防重複）。
  ui.click('saveBtn');
  assert.strictEqual(ui.count('apiSaveWeek'), 1);

  assert.strictEqual(ui.timers.run(ui.delayMs), 1);
  assert.deepStrictEqual(ui.message(), { type: 'error', text: expectedWeekMessage('apiSaveWeek') });
  assert.strictEqual(ui.els.saveBtn.textContent, '儲存', '按鈕文字要改回「儲存」');
  const reload = ui.take('apiLoadWeek');
  assert.deepStrictEqual(reload.args, [D], '重新載入同一個主日');
  reload.ok({ ok: true, data: {} });
  assert.deepStrictEqual(ui.log.weekLoaded, [D]);
  assert.strictEqual(ui.log.selectorLabels, 1, '主日下拉的標籤一併刷新');
  assert.deepStrictEqual(ui.message(), { type: 'error', text: expectedWeekMessage('apiSaveWeek') }, '重新載入之後訊息要保留');
  assert.strictEqual(ui.els.publishResult.classList.contains('hidden'), false, '同一主日重新載入，發佈結果保留');
  assert.strictEqual(ui.ctx.state.publish.pdfBase64, 'QUFB', '同一主日重新載入，已選的 PDF 保留');
  assert.strictEqual(ui.ctx.state.inFlight, 0);
  assertWrittenChinese(assert, 'G13 訊息', [ui.message().text, ui.els.busyBarText.textContent]);
});

test('G13-2 還原對話框按「確定」→ apiRestoreWeekSnapshot 收到 HTTP 502（2026-10-22 的情況）→ 時間到出新訊息，重新載入同一主日', function () {
  const ui = makeUi();
  clickRestoreButton(ui, 'SNAP-1');
  ui.take('apiDiffWeekSnapshot').ok(DIFF_OK);
  assert.strictEqual(ui.els.confirmDialogBackdrop.classList.contains('hidden'), false, '前提：確認對話框打開了');
  ui.click('confirmOkBtn');
  const restore = ui.take('apiRestoreWeekSnapshot');
  assert.strictEqual(restore.args[0].snapshotId, 'SNAP-1');
  restore.fail(new Error(NETWORK_502));

  assertReportedAsNoResponse(ui, 'apiRestoreWeekSnapshot', 'NetworkError');
  assert.strictEqual(ui.message(), null, '不可以再出「呼叫伺服器失敗」那一句');
  ui.timers.run(ui.delayMs);
  assert.deepStrictEqual(ui.message(), { type: 'error', text: expectedWeekMessage('apiRestoreWeekSnapshot') });
  const reload = ui.take('apiLoadWeek');
  assert.deepStrictEqual(reload.args, [D]);
  reload.ok({ ok: true, data: {} });
  assert.deepStrictEqual(ui.message(), { type: 'error', text: expectedWeekMessage('apiRestoreWeekSnapshot') });
});

test('G13-3 「重設這一週」按「確定」→ apiResetWeek 收到 HTTP 502 → 同一做法', function () {
  const ui = makeUi();
  ui.click('resetWeekBtn');
  ui.click('confirmOkBtn');
  ui.take('apiResetWeek').fail(new Error(NETWORK_502));
  ui.timers.run(ui.delayMs);
  assert.deepStrictEqual(ui.message(), { type: 'error', text: expectedWeekMessage('apiResetWeek') });
  assert.deepStrictEqual(ui.take('apiLoadWeek').args, [D]);
});

test('G13-4 發佈區按「執行」（只寄出）→ apiRunPublish 收到 HTTP 502：等候期間兩顆按鈕仍然停用；時間到視窗內、結果格、頁頂都出新訊息，重新載入同一主日與頁頂「目前已發佈」', function () {
  const ui = makeUi();
  ui.els.doSendCheck.checked = true;
  ui.click('publishRunBtn');
  ui.take('apiRunPublish').fail(new Error(NETWORK_502));

  assertReportedAsNoResponse(ui, 'apiRunPublish', 'HTTP 502');
  assert.strictEqual(ui.els.publishRunBtn.disabled, true, '等候期間「執行」不可以再按');
  assert.strictEqual(ui.els.publishConfirmOkBtn.disabled, true);

  ui.timers.run(ui.delayMs);
  const expected = expectedWeekMessage('apiRunPublish');
  assert.strictEqual(ui.els.publishConfirmError.textContent, expected, '發佈前檢查視窗內也要有（視窗會蓋住頁頂）');
  assert.strictEqual(ui.els.publishResult.textContent, expected);
  assert.deepStrictEqual(ui.message(), { type: 'error', text: expected });
  assert.strictEqual(ui.els.publishRunBtn.disabled, false, '時間到按鈕還原');
  assert.strictEqual(ui.log.publishPanel, 1, '要重新載入頁頂「目前已發佈」');
  const reload = ui.take('apiLoadWeek');
  assert.deepStrictEqual(reload.args, [D]);
  reload.ok({ ok: true, data: {} });
  assert.strictEqual(ui.els.publishResult.textContent, expected, '同一主日重新載入，結果格保留');
});

test('G13-5 季度作業「建立本季空白週報」按「確定」→ apiRunCreateWeeks 收到 HTTP 502 → 季度作業區塊內也有訊息，重新載入季度作業；不重新載入主日', function () {
  const ui = makeUi();
  ui.click('opCreateWeeksBtn');
  ui.take('apiPreviewCreateWeeks').ok({ ok: true, data: { ok: true, title: '建立本季空白週報', lines: ['會新增 13 個主日。'] } });
  ui.click('confirmOkBtn');
  ui.take('apiRunCreateWeeks').fail(new Error(NETWORK_502));
  ui.timers.run(ui.delayMs);
  const expected = '伺服器沒有回應（apiRunCreateWeeks），這個動作可能已經完成。系統已重新載入季度作業的現況，請先看「季度作業」區塊，確認未完成才再做一次。';
  assert.strictEqual(ui.els.quarterOpsMessage.textContent, expected);
  assert.deepStrictEqual(ui.message(), { type: 'error', text: expected });
  assert.strictEqual(ui.log.quarterOpsPanel, 1);
  assert.strictEqual(ui.count('apiLoadWeek'), 0, '成功時亦不重新載入主日，這裏照樣不載入（免得丟失未儲存的改動）');
});

test('G13-6 「建立講員表格」按「確定」→ apiCreateSpeakerForm 收到 HTTP 502 → 重新載入講員表格的現況；不重新載入主日', function () {
  const ui = makeUi();
  ui.click('speakerFormCreateBtn');
  ui.click('confirmOkBtn');
  ui.take('apiCreateSpeakerForm').fail(new Error(NETWORK_502));
  ui.timers.run(ui.delayMs);
  assert.deepStrictEqual(ui.message(), { type: 'error', text: '伺服器沒有回應（apiCreateSpeakerForm），這個動作可能已經完成。系統已重新載入講員表格的現況，請先看「講員表格」區塊，確認未完成才再做一次。' });
  assert.strictEqual(ui.log.speakerStatus, 1);
  assert.strictEqual(ui.count('apiLoadWeek'), 0);
});

test('G13-7 其他看來是連線問題的錯誤：Failed to fetch、timed out、HTTP 503、錯誤物件沒有訊息、callServer() 自己的逾時 → 全部走同一條補救', function () {
  [new Error('TypeError: Failed to fetch'), new Error('Request timed out'), new Error('Connection failure due to HTTP 503'),
    new Error(''), undefined, {}].forEach(function (err, i) {
    const ui = makeUi();
    ui.click('saveBtn');
    ui.take('apiSaveWeek').fail(err);
    assert.strictEqual(ui.timers.run(ui.delayMs), 1, '第 ' + i + ' 個要等候之後重新載入');
    assert.deepStrictEqual(ui.message(), { type: 'error', text: expectedWeekMessage('apiSaveWeek') }, '第 ' + i + ' 個');
    assert.strictEqual(ui.count('apiLoadWeek'), 1);
  });

  // callServer() 自己的逾時（120 秒內沒有回應）：寫入類同樣當作「沒有回應」。
  const ui = makeUi();
  ui.click('saveBtn');
  assert.strictEqual(ui.timers.run(120000), 1, '前提：逾時計時器是 120 秒');
  assertReportedAsNoResponse(ui, 'apiSaveWeek', '秒內沒有回應');
  ui.timers.run(ui.delayMs);
  assert.deepStrictEqual(ui.message(), { type: 'error', text: expectedWeekMessage('apiSaveWeek') });
  assert.strictEqual(ui.count('apiLoadWeek'), 1);
});

test('G13-8 伺服器明確回傳的錯誤照舊：STALE（ok:false）原句顯示；伺服器拋出的例外仍是「呼叫伺服器失敗（…）」；兩者都不等候、不重新載入', function () {
  const stale = '這一週在你載入之後已經有人儲存過（2026-10-22 09:05:00），請重新載入再改。';
  const ui = makeUi();
  ui.click('saveBtn');
  ui.take('apiSaveWeek').ok({ ok: false, error: { code: 'STALE', message: stale } });
  assert.deepStrictEqual(ui.message(), { type: 'error', text: stale });
  assert.strictEqual(ui.timers.pending(ui.delayMs), 0);
  assert.strictEqual(ui.count('apiLoadWeek'), 0);
  assert.strictEqual(ui.count('apiLogClientError'), 0, 'STALE 是伺服器回傳的結果，不是前端錯誤');
  assert.strictEqual(ui.ctx.state.inFlight, 0);

  const ui2 = makeUi();
  ui2.click('saveBtn');
  ui2.take('apiSaveWeek').fail(new Error('Exception: 你沒有權限編輯這個試算表。'));
  assert.deepStrictEqual(ui2.message(), { type: 'error', text: '呼叫伺服器失敗（apiSaveWeek）：Exception: 你沒有權限編輯這個試算表。' });
  assert.strictEqual(ui2.timers.pending(ui2.delayMs), 0);
  assert.strictEqual(ui2.count('apiLoadWeek'), 0);
  const report = ui2.take('apiLogClientError').args[0];
  assert.strictEqual(report.message, '呼叫伺服器失敗（apiSaveWeek）：Exception: 你沒有權限編輯這個試算表。', '不加「連線錯誤」那一句');
  assert.strictEqual(ui2.els.saveBtn.textContent, '儲存');
});

test('G13-9 讀取類失敗照舊：按「還原到這個版本」時 apiDiffWeekSnapshot 收到 HTTP 502 → 即時顯示「呼叫伺服器失敗（apiDiffWeekSnapshot）：…」，不等候、不重新載入', function () {
  const ui = makeUi();
  clickRestoreButton(ui, 'SNAP-1');
  ui.take('apiDiffWeekSnapshot').fail(new Error(NETWORK_502));
  assert.deepStrictEqual(ui.message(), { type: 'error', text: '呼叫伺服器失敗（apiDiffWeekSnapshot）：' + NETWORK_502 });
  assert.strictEqual(ui.timers.pending(ui.delayMs), 0);
  assert.strictEqual(ui.count('apiLoadWeek'), 0);
  assert.strictEqual(ui.count('apiRestoreWeekSnapshot'), 0);
  assert.ok(ui.take('apiLogClientError').args[0].message.indexOf('（連線錯誤') === -1);
});

test('G13-10 分類：Script.html 用到的每一個 api 名稱都分了寫入或讀取；寫入類每一種都有提示句；清單內每一個都是真的 api 函式', function () {
  const js = readSrc('src/ui/Script.html');
  const ui = makeUi();
  const table = JSON.parse(JSON.stringify(ui.ctx.WRITE_ACTION_RECOVERY));
  const hints = JSON.parse(JSON.stringify(ui.ctx.NO_RESPONSE_CHECK_HINTS));
  // 讀取類（以及刻意不納入的三個，理由見 Script.html 的 WRITE_ACTION_RECOVERY 說明）。
  const notWrite = [
    'apiListWeeks', 'apiLoadWeek', 'apiPreviewProgram', 'apiPreviewContentImport', 'apiListWeekSnapshots',
    'apiDiffWeekSnapshot', 'apiGetSpeakerFormStatus', 'apiGetRosterFetchCandidates', 'apiGetPublishStatus',
    'apiGetQuarterOpsPanel', 'apiPreviewCreateWeeks', 'apiPreviewContentSheetBuild', 'apiPreviewContentSheetInvite',
    'apiPreviewQuarterContentImport', 'apiQuarterMissingReport', 'apiRosterDiffReport', 'apiGoLiveReport',
    'apiPublishRevisionsReport', 'apiDownloadBulletinDocx', 'apiSavePublishPrefs', 'apiLogClientError'
  ];
  const used = {};
  (js.match(/'api[A-Z][A-Za-z]+'/g) || []).forEach(function (s) { used[s.slice(1, -1)] = true; });
  Object.keys(used).forEach(function (name) {
    const isWrite = Object.prototype.hasOwnProperty.call(table, name);
    const isRead = notWrite.indexOf(name) !== -1;
    assert.ok(isWrite !== isRead, name + ' 要在 WRITE_ACTION_RECOVERY 或讀取類清單其中一處（只可以一處）');
  });
  const gs = fs.readdirSync(path.join(__dirname, '..', 'src')).filter(function (f) { return f.endsWith('.gs'); })
    .map(function (f) { return readSrc('src/' + f); }).join('\n');
  Object.keys(table).forEach(function (name) {
    assert.ok(used[name], name + ' 在清單內，但 Script.html 沒有用到');
    assert.ok(gs.indexOf('function ' + name + '(') !== -1, name + ' 不是 src/*.gs 內的函式');
    assert.ok(typeof hints[table[name]] === 'string' && hints[table[name]].length > 0, name + ' 的種類 ' + table[name] + ' 沒有提示句');
  });
  assert.deepStrictEqual(Object.keys(table).sort(), [
    'apiBackfillRoster', 'apiCreateSpeakerForm', 'apiFetchFromRoster', 'apiRefreshSpeakerFormDates', 'apiResetWeek',
    'apiRestoreWeekSnapshot', 'apiRunContentImport', 'apiRunContentSheetBuild', 'apiRunContentSheetInvite',
    'apiRunCreateWeeks', 'apiRunPublish', 'apiRunQuarterContentImport', 'apiSaveWeek'
  ]);
  assertWrittenChinese(assert, 'G13 提示句', Object.keys(hints).map(function (k) { return hints[k]; }));
  // 等候時間要比 2026-10-22 那一次多出的 10.6 秒長，亦要比 callServer() 的逾時短。
  assert.ok(ui.delayMs >= 15000 && ui.delayMs < 120000, String(ui.delayMs));
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
