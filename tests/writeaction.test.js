#!/usr/bin/env node
/**
 * tests/writeaction.test.js
 *
 * 第二批測試修正 G13：寫入類動作遇到連線錯誤（例如 HTTP 502）時，訊息改講「這個動作
 * 可能已經完成」，等一會之後自動重新載入同一個主日（保留訊息、不觸發換週清理）。
 * 儲存例外（FF-13）：即時講「儲存可能已經完成，你的改動仍在畫面上」，不重新載入，
 * 表單與未儲存的狀態保留；再按「儲存」時如果上一次其實已經存好，伺服器的樂觀鎖回
 * STALE（後端那一條經真正入口 apiSaveWeek 驗證）。伺服器明確回傳的錯誤與讀取類動作
 * 的失敗照舊。
 *
 * 前端函式用「BEGIN／END 標記」與函式名稱從 Script.html 抽出來，在假 DOM 上真的
 * 執行；google.script.run 用假替身，由測試決定成功或失敗。一律經真正入口：按鈕的
 * click 事件由真正的 wireStaticEvents()／wireQuarterOpsEvents() 接上，還原按鈕由
 * 真正的 renderSnapshotList() 畫出來。
 *
 * 第二批測試修正 G15：「重設這一週」與「還原到這個版本」對話框按「取消」，與季度作業
 * 一樣顯示「已取消，一格都沒有寫。」（同一個常數），而且一個寫入請求都不送。
 *
 * 第二批測試修正 G17：讀取類動作逾時，訊息講「這是讀取資料，沒有改動週報內容」（G17 補充改字眼），不講
 * 「動作可能已經做了」，不排重新載入；下載 Word 逾時講沒有下載到；寫入類照舊。
 *
 * 之後各輪（每組測試的標題寫明）：G18／G22(a) 發佈的提示句、G19 取消字眼、G20「處理填寫表
 * 衝突」對話框、G21 發佈不重新載入主日、G23 儲存的指令碼鎖、G24 連線錯誤與逾時兩種結尾、
 * G25 等候期間對話框不可以再送、G26 HTTP 401／403、G27 重新載入亦失敗。
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
const { makeFillEnv, QUARTER_ID } = require('./helpers/fillEnv');
const { changedDutyCells } = require('./helpers/savePayload');

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
 * callServer() 與 G13 的補救、確認對話框、版本記錄的還原與重設（內容表 v2：講員表格已停用，那一段已拿走）、
 * loadWeek()、未儲存改動的判斷（week-diff／week-switch-guard）、儲存（連
 * buildSavePayload()）、發佈、季度作業、wireStaticEvents()。表單本身用 ctx.form 代替
 * （collectWeekFieldsFromForm() 的替身讀它）；其餘函式用記錄呼叫的替身。
 */
function makeUi(options) {
  const js = readSrc('src/ui/Script.html');
  // G17：測試可以多抽幾段真正的程式碼（[開頭, 結尾] 兩個字串），蓋過下面的替身。
  const extra = (options && options.extra) || [];
  const dom = makeFakeDom();
  const timers = makeFakeTimers();
  const calls = [];
  const log = { weekLoaded: [], selectorLabels: 0, publishPanel: 0, quarterOpsPanel: 0 };
  const ctx = {
    console: console,
    google: makeFakeGoogle(calls),
    document: dom.document,
    window: { addEventListener: function () {} },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    el: function (tag, className) { return dom.makeEl(tag, className); },
    escapeHtml: function (t) { return String(t); },
    state: {
      isoDate: D, showArchived: false, quarters: [], quarterId: '2028T2', lastSavedAt: '2026-10-22 09:00:00',
      loaded: true, inFlight: 0, previewInFlight: 0, week: {}, loadedWeek: { PAGE_TITLE: '' }, snapshotsLoadedFor: null,
      dutyEdits: {}, nextWeekDutyEdits: {}, loadedDutyNames: {}, loadedNextDutyNames: {},
      fetchCandidates: [],
      quarterOps: { quarterId: '2028T2', dryRun: true },
      publish: { pdfBase64: '', pdfName: '', pdfIsoDate: '', panel: { maxPdfMb: 10 }, confirmButton: '' },
      // v3：畫面上的主日在發佈時窗之內（只有該週可以發佈或寄出）。
      publishWindow: { isCurrentWeek: true, notice: '' }
    },
    // ---- 替身：只記錄有沒有被叫 ----
    onWeekLoaded: function (isoDate) { log.weekLoaded.push(isoDate); ctx.state.isoDate = isoDate; ctx.setLoaded(true); },
    refreshWeekSelectorLabels: function () { log.selectorLabels++; },
    loadPublishPanel: function () { log.publishPanel++; },
    refreshQuarterOpsPanel: function () { log.quarterOpsPanel++; },
    // 表單：測試直接改 ctx.form 等於幹事在畫面上打字。
    form: { PAGE_TITLE: '' },
    collectWeekFieldsFromForm: function () { return Object.assign({}, ctx.form); },
    CONTENT_SHEET_WEEK_FIELDS: [],
    selectedPublishGroups: function () { return ['ADMIN']; },
    openPublishConfirm: function () {},
    closePublishConfirm: function () {},
    isSnapshotPanelOpen: function () { return false; },
    loadSnapshotPanel: function () {},
    onWeekSelectChanged: function () {}, onQuarterChanged: function () {}, onShowArchivedChanged: function () {},
    stepWeek: function () {}, backfillRoster: function () {}, reloadRosterOnly: function () {},
    openFetchFromRosterDialog: function () {}, closeFetchDialog: function () {}, confirmFetchFromRoster: function () {},
    setAllFetchCheckboxes: function () {}, applyPublishSubStates: function () {}, savePublishPrefs: function () {},
    downloadWord: function () {}, renderFlowerHints: function () {},
    schedulePreviewRefresh: function () {},
    // v3：wireStaticEvents() 新接的幾粒（與這裏驗的寫入動作無關）。
    copyPreviewLink: function () {}, confirmProgramAdd: function () {}, closeProgramAddForm: function () {},
    refreshUnsavedIndicator: function () {}, updateSnapshotButtons: function () {}, onSnapshotDiffClicked: function () {},
    // 2026-10-30：特別崇拜（與這裏驗的寫入動作無關）。
    toggleSpecialServiceForm: function () {}, startCreateSpecialService: function () {}, renderSpecialServiceBanner: function () {}
  };
  vm.createContext(ctx);
  const code = [
    region(js, 'message-bar'),
    between(js, 'function setLoaded(', '// BEGIN call-server'),
    region(js, 'call-server'),
    region(js, 'confirm-dialog'),
    region(js, 'snapshot-panel'),
    // 內容表 v2：講員表格已停用，speaker-form 一段已拿走；還原與重設之後緊接的是 word-file。
    between(js, 'function onSnapshotRestoreClicked(', '// BEGIN word-file'),
    region(js, 'load-week'),
    region(js, 'week-diff'),
    region(js, 'week-switch-guard'),
    between(js, 'function buildSavePayload(', 'function refreshWeekSelectorLabels('),
    region(js, 'publish-run'),
    region(js, 'publish-window'),
    between(js, 'function setPublishButtonsBusy(', '// BEGIN publish-result'),
    region(js, 'publish-result'),
    // v3：版本記錄改為下拉，「還原到這個版本…」按鈕用揀中的版本（真正的 selectedSnapshotId()）。
    between(js, 'function selectedSnapshotId(', 'function updateSnapshotButtons('),
    // v3：季度作業區塊已經由填寫介面拿走（Ivan 測試結果 A 第 15 項），wireStaticEvents() 之後緊接的是 wireGlobalErrorHandlers()。
    between(js, 'function wireStaticEvents(', 'function wireGlobalErrorHandlers('),
    // G19：兩個對話框的「取消」（wireStaticEvents() 接上的是真正的函式）。
    between(js, 'function closeFetchDialog(', 'function confirmFetchFromRoster('),
    between(js, 'function openPublishConfirm(', 'function downloadWord(')
  ].concat(extra.map(function (pair) { return between(js, pair[0], pair[1]); })).join('\n');
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

/** v3：經真正的 renderSnapshotPicker() 把一個版本放進下拉，揀中它，按「還原到這個版本…」（wireStaticEvents() 接上的真按鈕）。 */
function clickRestoreButton(ui, snapshotId) {
  const select = ui.dom.document.getElementById('snapshotSelect');
  ui.ctx.renderSnapshotPicker(select, ui.dom.document.getElementById('snapshotDetail'),
    [{ snapshotId: snapshotId, createdAt: '2026-10-22 08:00', createdBy: 'ivan', reasonLabel: '填寫介面儲存', summary: '' }]);
  select.value = snapshotId;
  ui.click('snapshotRestoreBtn');
}

const DIFF_OK = { ok: true, data: { createdAt: '2026-10-22 08:00', reasonLabel: '填寫介面儲存', rows: [], noteLine: '還原前會先自動存一個版本。', lastSavedAt: '2026-10-22 09:00:00' } };

const EXPECTED_SAVE_MESSAGE = '伺服器沒有回應（apiSaveWeek），儲存可能已經完成，你的改動仍在畫面上。請再按一次「儲存」：如果系統說「這一週的資料在你載入之後被改過」，即是上一次已經存好，重新載入這一週就會看到。';

// G24 改了以下幾句的結尾：不再叫人「確認未完成才再做一次」，改叫人等 5 分鐘再核對、不要即時再做。
const WAIT_ENDING = '如果仍未看到結果，伺服器可能仍在處理，請等 5 分鐘再重新載入核對，不要即時再做一次。';
const EXPECTED_SEND_ONLY_MESSAGE = '伺服器沒有回應（apiRunPublish），這個動作可能已經完成。寄出不會在填寫介面留下記錄，'
  + '請先看試算表的 SendLog 有沒有剛才這一次的寄出記錄（模擬模式亦會記錄）。'
  + '如果仍未看到記錄，伺服器可能仍在處理，請等 5 分鐘再看一次，不要即時再寄，以免重複寄信。';
const EXPECTED_PUBLISH_ONLY_MESSAGE = '伺服器沒有回應（apiRunPublish），這個動作可能已經完成。系統已重新載入頁頂「目前已發佈」，'
  + '請先看它的主日、版本和發佈時間是否已經是剛才這一次（「版本記錄」上方的發佈記錄亦會多一版）。' + WAIT_ENDING;
const EXPECTED_PUBLISH_AND_SEND_MESSAGE = '伺服器沒有回應（apiRunPublish），這個動作可能已經完成。系統已重新載入頁頂「目前已發佈」，'
  + '請先看它的主日、版本和發佈時間是否已經是剛才這一次；寄出不會在填寫介面留下記錄，請看試算表的 SendLog 有沒有剛才這一次的寄出記錄。'
  + WAIT_ENDING + '已經發佈而未寄出的話，再做時只勾「寄出」。';
const EXPECTED_SAVE_TIMEOUT_MESSAGE = '伺服器在 120 秒內沒有回應（apiSaveWeek），伺服器可能仍在處理，你的改動仍在畫面上。'
  + '請等一兩分鐘才再按「儲存」：如果系統說「這一週的資料在你載入之後被改過」，即是上一次已經存好，重新載入這一週就會看到。';

/** G24：寫入類（儲存除外）逾時的一句。where 是重新載入頁面之後要看的地方。 */
function expectedTimeoutMessage(fnName, where, noRedo, note) {
  return '伺服器在 120 秒內沒有回應（' + fnName + '），伺服器可能仍在處理（最長約 6 分鐘）。請等 6 分鐘後重新載入頁面，再看'
    + where + '核對，' + (noRedo || '不要即時再做一次') + '；亦可請 IT 看 Apps Script 的「執行項目」。' + (note || '');
}

/** 已選好這一週的 PDF、按「執行」，伺服器收到 HTTP 502，等候時間到。 */
function publishWith502(ui, doPublish, doSend) {
  Object.assign(ui.ctx.state.publish, { pdfBase64: 'QUFB', pdfName: '週報.pdf', pdfIsoDate: D });
  ui.els.doPublishCheck.checked = doPublish;
  ui.els.doSendCheck.checked = doSend;
  ui.click('publishRunBtn');
  const call = ui.take('apiRunPublish');
  assert.strictEqual(call.args[0].doPublish, doPublish);
  assert.strictEqual(call.args[0].doSend, doSend);
  call.fail(new Error(NETWORK_502));
  assert.strictEqual(ui.timers.run(ui.delayMs), 1);
}

function expectedWeekMessage(fnName) {
  return '伺服器沒有回應（' + fnName + '），這個動作可能已經完成。系統已重新載入這一個主日，請先看「最後儲存時間」和「版本記錄」。' + WAIT_ENDING;
}

/**
 * 斷言：apiLogClientError 收到原本的錯誤內容，加上「（連線錯誤，動作可能已完成）」；
 * G24：逾時（timedOut）加的是「（逾時，動作可能仍在處理）」。
 */
function assertReportedAsNoResponse(ui, fnName, rawFragment, timedOut) {
  const reports = ui.calls.filter(function (c) { return c.name === 'apiLogClientError'; });
  assert.strictEqual(reports.length, 1, '要即時回報一次 ErrorLog');
  const payload = reports[0].args[0];
  assert.strictEqual(payload.functionName, fnName);
  assert.ok(payload.message.indexOf('呼叫伺服器失敗（' + fnName + '）：') === 0, payload.message);
  assert.ok(payload.message.indexOf(rawFragment) !== -1, '要保留原本的錯誤內容：' + payload.message);
  assert.ok(payload.message.endsWith(timedOut ? '（逾時，動作可能仍在處理）' : '（連線錯誤，動作可能已完成）'), payload.message);
}

// =====================================================================
// G13：寫入類動作遇到連線錯誤
// =====================================================================

console.log('\n寫入類動作遇到連線錯誤（G13）');

test('G13-1 按「儲存」→ apiSaveWeek 收到 HTTP 502：即時出儲存那一句；不等候、不重新載入；畫面上的改動與未儲存的狀態保留，「儲存」即時可以再按；再按送出同一份 payload，伺服器回 STALE 就原句顯示', function () {
  const ui = makeUi();
  ui.ctx.form.PAGE_TITLE = '新序樂';                       // 幹事在畫面上打了字
  assert.strictEqual(ui.ctx.hasUnsavedWeekChanges(), true, '前提：有未儲存的改動');

  ui.click('saveBtn');
  const first = ui.take('apiSaveWeek');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(first.args[0].week)), { PAGE_TITLE: '新序樂' });
  first.fail(new Error(NETWORK_502));

  assertReportedAsNoResponse(ui, 'apiSaveWeek', 'HTTP 502');
  assert.deepStrictEqual(ui.message(), { type: 'error', text: EXPECTED_SAVE_MESSAGE }, '即時顯示，不等候');
  assert.strictEqual(ui.timers.pending(ui.delayMs), 0, '不可以排重新載入');
  assert.strictEqual(ui.count('apiLoadWeek'), 0, '不可以重新載入');
  assert.strictEqual(ui.ctx.state.inFlight, 0);
  assert.strictEqual(ui.els.saveBtn.disabled, false, '「儲存」要即時可以再按');
  assert.strictEqual(ui.els.saveBtn.textContent, '儲存');
  assert.strictEqual(ui.ctx.form.PAGE_TITLE, '新序樂', '畫面上的改動保留');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ui.ctx.state.loadedWeek)), { PAGE_TITLE: '' }, '載入時的值不變（未儲存的狀態以它為準）');
  assert.strictEqual(ui.ctx.hasUnsavedWeekChanges(), true, '仍然算是未儲存（換週會先問）');
  assert.strictEqual(ui.ctx.state.lastSavedAt, '2026-10-22 09:00:00', '樂觀鎖用的時間不變，再按才擋得住重複寫入');

  // 再按一次：送出同一份 payload（同一個 lastSavedAt、同一個 baseWeek）。
  ui.click('saveBtn');
  const second = ui.take('apiSaveWeek');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(second.args[0])), JSON.parse(JSON.stringify(first.args[0])));
  const stale = '這一週的資料在你載入之後被改過（工作表上的最後儲存時間是 2026-10-22 09:00:30，你載入時是 2026-10-22 09:00:00）。請重新載入後再儲存，以免覆蓋別人的修改。';
  second.ok({ ok: false, error: { code: 'STALE', message: stale } });
  assert.deepStrictEqual(ui.message(), { type: 'error', text: stale });
  assert.strictEqual(ui.count('apiLoadWeek'), 0);
  assertWrittenChinese(assert, 'G13 儲存訊息', [EXPECTED_SAVE_MESSAGE]);
});

test('G13-2 還原對話框按「確定」→ apiRestoreWeekSnapshot 收到 HTTP 502（2026-10-22 的情況）：即時回報 ErrorLog；等候期間介面忙碌、不可以再按；時間到出新訊息，重新載入同一主日並保留訊息，發佈區不被換週清理', function () {
  const ui = makeUi();
  // 前提：發佈區有這一週的結果與已選的 PDF（G3／G9 的換週清理不可以清走）。
  ui.ctx.showPublishResult('已發佈第 3 版。', false);
  Object.assign(ui.ctx.state.publish, { pdfBase64: 'QUFB', pdfName: '週報.pdf', pdfIsoDate: D });

  clickRestoreButton(ui, 'SNAP-1');
  ui.take('apiDiffWeekSnapshot').ok(DIFF_OK);
  assert.strictEqual(ui.els.confirmDialogBackdrop.classList.contains('hidden'), false, '前提：確認對話框打開了');
  ui.click('confirmOkBtn');
  const restore = ui.take('apiRestoreWeekSnapshot');
  assert.strictEqual(restore.args[0].snapshotId, 'SNAP-1');
  restore.fail(new Error(NETWORK_502));

  assertReportedAsNoResponse(ui, 'apiRestoreWeekSnapshot', 'NetworkError');
  assert.strictEqual(ui.message(), null, '等候期間不可以出「呼叫伺服器失敗」，亦未講「已重新載入」');
  assert.strictEqual(ui.ctx.state.inFlight, 1, '等候期間介面維持忙碌');
  assert.strictEqual(ui.els.saveBtn.disabled, true, '等候期間不可以按其他會寫入的按鈕');
  assert.strictEqual(ui.els.confirmOkBtn.disabled, true);
  assert.ok(ui.els.busyBarText.textContent.indexOf('伺服器沒有回應') === 0, ui.els.busyBarText.textContent);
  assert.strictEqual(ui.count('apiLoadWeek'), 0, '未等完不可以重新載入');

  assert.strictEqual(ui.timers.run(ui.delayMs), 1);
  assert.deepStrictEqual(ui.message(), { type: 'error', text: expectedWeekMessage('apiRestoreWeekSnapshot') });
  const reload = ui.take('apiLoadWeek');
  assert.deepStrictEqual(reload.args, [D], '重新載入同一個主日');
  reload.ok({ ok: true, data: {} });
  assert.deepStrictEqual(ui.log.weekLoaded, [D]);
  assert.strictEqual(ui.log.selectorLabels, 1, '主日下拉的標籤一併刷新');
  assert.deepStrictEqual(ui.message(), { type: 'error', text: expectedWeekMessage('apiRestoreWeekSnapshot') }, '重新載入之後訊息要保留');
  assert.strictEqual(ui.els.publishResult.classList.contains('hidden'), false, '同一主日重新載入，發佈結果保留');
  assert.strictEqual(ui.ctx.state.publish.pdfBase64, 'QUFB', '同一主日重新載入，已選的 PDF 保留');
  assert.strictEqual(ui.ctx.state.inFlight, 0);
  assertWrittenChinese(assert, 'G13 訊息', [ui.message().text, ui.els.busyBarText.textContent]);
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

test('G13-4 發佈區按「執行」（只寄出）→ apiRunPublish 收到 HTTP 502：等候期間兩顆按鈕仍然停用；時間到視窗內、結果格、頁頂都出新訊息，重新載入頁頂「目前已發佈」（G21：不重新載入主日）', function () {
  const ui = makeUi();
  ui.els.doSendCheck.checked = true;
  ui.click('publishRunBtn');
  ui.take('apiRunPublish').fail(new Error(NETWORK_502));

  assertReportedAsNoResponse(ui, 'apiRunPublish', 'HTTP 502');
  assert.strictEqual(ui.els.publishRunBtn.disabled, true, '等候期間「執行」不可以再按');
  assert.strictEqual(ui.els.publishConfirmOkBtn.disabled, true);

  ui.timers.run(ui.delayMs);
  // G18／G22(a) 改了這一句的預期：只寄出不會改「最後儲存時間」與版本記錄，要叫人看 SendLog。
  const expected = EXPECTED_SEND_ONLY_MESSAGE;
  assert.strictEqual(ui.els.publishConfirmError.textContent, expected, '發佈前檢查視窗內也要有（視窗會蓋住頁頂）');
  assert.strictEqual(ui.els.publishResult.textContent, expected);
  assert.deepStrictEqual(ui.message(), { type: 'error', text: expected });
  assert.strictEqual(ui.els.publishRunBtn.disabled, false, '時間到按鈕還原');
  assert.strictEqual(ui.log.publishPanel, 1, '要重新載入頁頂「目前已發佈」');
  // G21 改了這一條的預期：以前會重新載入這一個主日，但發佈成功時從來不重新載入主日，
  // 而重新載入會換走表單上未儲存的改動。不要改回去。
  assert.strictEqual(ui.count('apiLoadWeek'), 0, '發佈沒有回應不重新載入主日');
  assert.strictEqual(ui.log.selectorLabels, 0);
  assert.strictEqual(ui.els.publishResult.textContent, expected, '結果格保留');
});

test('G21-1 表單有未儲存的改動 → 按「執行」發佈 → 502 → 20 秒之後只重新載入頁頂「目前已發佈」，不送 apiLoadWeek；畫面上的改動與未儲存的狀態保留', function () {
  const ui = makeUi();
  ui.ctx.form.PAGE_TITLE = '新序樂';
  assert.strictEqual(ui.ctx.hasUnsavedWeekChanges(), true, '前提：有未儲存的改動');
  publishWith502(ui, true, false);
  assert.strictEqual(ui.count('apiLoadWeek'), 0, '不可以重新載入主日');
  assert.strictEqual(ui.log.publishPanel, 1);
  assert.strictEqual(ui.ctx.form.PAGE_TITLE, '新序樂');
  assert.strictEqual(ui.ctx.hasUnsavedWeekChanges(), true, '仍然算是未儲存（換週會先問）');
  assert.strictEqual(ui.ctx.state.inFlight, 0);
});

test('G21-2 版本記錄展開着 → 發佈沒有回應之後一併重新載入版本記錄（上方的「已發佈」一段）；收起着就不載入', function () {
  const open = makeUi();
  let snapshotLoads = 0;
  open.ctx.isSnapshotPanelOpen = function () { return true; };
  open.ctx.loadSnapshotPanel = function () { snapshotLoads++; };
  publishWith502(open, true, false);
  assert.strictEqual(snapshotLoads, 1);

  const closed = makeUi();
  let closedLoads = 0;
  closed.ctx.loadSnapshotPanel = function () { closedLoads++; };
  publishWith502(closed, true, false);
  assert.strictEqual(closedLoads, 0);
});

test('G21-3 其他種類與成功時一致：還原、重設、匯入、補抓、由職事表重新取數、更新本季內容表成功時本來就重新載入主日，沒有回應亦重新載入', function () {
  const ui = makeUi();
  const table = JSON.parse(JSON.stringify(ui.ctx.WRITE_ACTION_RECOVERY));
  const reloadsWeek = Object.keys(table).filter(function (k) { return table[k] === 'week'; }).sort();
  // v3：季度作業（包括整季匯入）已經由填寫介面拿走；「更新本季內容表…」在內容表狀態列，成功之後重新載入主日。
  // 2026-10-30：加「建立特別崇拜」（成功之後打開新建的那一期）。
  assert.deepStrictEqual(reloadsWeek, ['apiBackfillRoster', 'apiCreateSpecialService', 'apiFetchFromRoster', 'apiResetWeek',
    'apiRestoreWeekSnapshot', 'apiRunContentImport', 'apiRunContentSheetBuild']);
  // 這六個成功處理都會叫 loadWeek()（逐個核對 Script.html 的成功路徑）。
  const js = readSrc('src/ui/Script.html');
  [['function onContentImportDone(', 'function applyBaptismPanelVisibility('],
    ['function onSnapshotRestoreClicked(', 'function onResetWeekClicked('],
    ['function onResetWeekClicked(', '// BEGIN word-file'],
    ['function confirmFetchFromRoster(', 'function schedulePreviewRefresh('],
    ['function backfillRoster(', 'function wireStaticEvents('],
    ['function startCreateSpecialService(', 'function renderRosterGapBanner('],
    ["callServer('apiRunContentSheetBuild'", 'function onContentImportDone(']].forEach(function (pair) {
    assert.ok(between(js, pair[0], pair[1]).indexOf('loadWeek(') !== -1, pair[0] + ' 成功時要重新載入主日');
  });
  const publishOk = between(js, 'function onPublishDone(', '// BEGIN publish-result');
  assert.strictEqual(publishOk.indexOf('loadWeek('), -1, '發佈成功時不重新載入主日');
});

// v3（Ivan 測試結果 A 第 15 項）：季度作業區塊已經由填寫介面拿走，G13-5 改驗取代它的「更新本季內容表…」。
test('G13-5 「更新本季內容表…」按「確定」→ apiRunContentSheetBuild 收到 HTTP 502 → 等候之後重新載入這一個主日，講可能已經完成', function () {
  const ui = makeUi({ extra: [['function startContentSheetUpgrade(', 'function onContentImportDone(']] });
  ui.ctx.startContentSheetUpgrade();
  ui.take('apiPreviewContentSheetBuild').ok({ ok: true, data: { ok: true, lines: ['會加上新的欄。'] } });
  assert.strictEqual(ui.els.confirmDialogBackdrop.classList.contains('hidden'), false, '前提：確認對話框打開了');
  ui.click('confirmOkBtn');
  const run = ui.take('apiRunContentSheetBuild');
  assert.deepStrictEqual(run.args, ['2028T2']);
  run.fail(new Error(NETWORK_502));
  assert.strictEqual(ui.count('apiLoadWeek'), 0, '未等完不可以重新載入');
  ui.timers.run(ui.delayMs);
  assert.deepStrictEqual(ui.message(), { type: 'error', text: expectedWeekMessage('apiRunContentSheetBuild') });
  assert.deepStrictEqual(ui.take('apiLoadWeek').args, [D]);
});

// 內容表 v2：G13-6（「建立講員表格」沒有回應）拿走——講員表格已停用，填寫介面沒有那粒按鈕，
//    apiCreateSpeakerForm 在伺服器一律回 SPEAKER_FORM_RETIRED（見 tests/retire.test.js）。

test('G13-7 其他看來是連線問題的錯誤：Failed to fetch、timed out、HTTP 503、錯誤物件沒有訊息、callServer() 自己的逾時 → 重設走等候再重新載入；儲存即時出儲存那一句、不重新載入', function () {
  [new Error('TypeError: Failed to fetch'), new Error('Request timed out'), new Error('Connection failure due to HTTP 503'),
    new Error(''), undefined, {}].forEach(function (err, i) {
    const ui = makeUi();
    ui.click('resetWeekBtn');
    ui.click('confirmOkBtn');
    ui.take('apiResetWeek').fail(err);
    assert.strictEqual(ui.timers.run(ui.delayMs), 1, '第 ' + i + ' 個要等候之後重新載入');
    assert.deepStrictEqual(ui.message(), { type: 'error', text: expectedWeekMessage('apiResetWeek') }, '第 ' + i + ' 個');
    assert.strictEqual(ui.count('apiLoadWeek'), 1);

    const save = makeUi();
    save.click('saveBtn');
    save.take('apiSaveWeek').fail(err);
    assert.deepStrictEqual(save.message(), { type: 'error', text: EXPECTED_SAVE_MESSAGE }, '儲存第 ' + i + ' 個');
    assert.strictEqual(save.timers.pending(save.delayMs), 0);
    assert.strictEqual(save.count('apiLoadWeek'), 0);
  });

  // callServer() 自己的逾時（120 秒內沒有回應）：寫入類同樣當作「沒有回應」。
  // G24 改了預期：逾時用另一句（伺服器可能仍在處理、等 6 分鐘、執行項目）。
  const ui = makeUi();
  ui.click('resetWeekBtn');
  ui.click('confirmOkBtn');
  assert.strictEqual(ui.timers.run(120000), 1, '前提：逾時計時器是 120 秒');
  assertReportedAsNoResponse(ui, 'apiResetWeek', '秒內沒有回應', true);
  ui.timers.run(ui.delayMs);
  assert.deepStrictEqual(ui.message(), { type: 'error', text: expectedTimeoutMessage('apiResetWeek', '「最後儲存時間」和「版本記錄」') });
  assert.strictEqual(ui.count('apiLoadWeek'), 1);

  const save = makeUi();
  save.click('saveBtn');
  assert.strictEqual(save.timers.run(120000), 1);
  assertReportedAsNoResponse(save, 'apiSaveWeek', '秒內沒有回應', true);
  assert.deepStrictEqual(save.message(), { type: 'error', text: EXPECTED_SAVE_TIMEOUT_MESSAGE });
  assert.strictEqual(save.count('apiLoadWeek'), 0);
  assert.strictEqual(save.els.saveBtn.disabled, false);
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
    'apiDiffWeekSnapshot', 'apiGetRosterFetchCandidates', 'apiGetPublishStatus',
    'apiGetQuarterOpsPanel', 'apiPreviewCreateWeeks', 'apiPreviewContentSheetBuild', 'apiPreviewContentSheetInvite',
    'apiPreviewQuarterContentImport', 'apiQuarterMissingReport', 'apiRosterDiffReport', 'apiGoLiveReport',
    'apiPublishRevisionsReport', 'apiDownloadBulletinDocx', 'apiSavePublishPrefs', 'apiLogClientError',
    // 2026-10-28：Word 預覽與「下載 Word」同一類（只更新雲端硬碟上同一個 Word，再按一次無害），有自己的逾時句。
    'apiOpenWordPreview',
    // 2026-10-30：建立特別崇拜的預覽（唯讀）。
    'apiPreviewCreateSpecialService'
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
    // 內容表 v2：apiCreateSpeakerForm、apiRefreshSpeakerFormDates 隨講員表格停用拿走。
    // v3：季度作業區塊拿走，apiRunContentSheetInvite、apiRunCreateWeeks、apiRunQuarterContentImport 不再由填寫介面叫。
    // 2026-10-30：apiCreateSpecialService（建立特別崇拜）。
    'apiBackfillRoster', 'apiCreateSpecialService', 'apiFetchFromRoster', 'apiResetWeek',
    'apiRestoreWeekSnapshot', 'apiRunContentImport', 'apiRunContentSheetBuild',
    'apiRunPublish', 'apiSaveWeek'
  ]);
  assertWrittenChinese(assert, 'G13 提示句', Object.keys(hints).map(function (k) { return hints[k]; }));
  // 等候時間要比 2026-10-22 那一次多出的 10.6 秒長，亦要比 callServer() 的逾時短。
  assert.ok(ui.delayMs >= 15000 && ui.delayMs < 120000, String(ui.delayMs));
});

test('G13-11 後端（真正入口 apiSaveWeek）：同一份儲存 payload 送兩次，第二次回 STALE，訊息以「這一週的資料在你載入之後被改過」開頭（儲存那一句引用的就是它），而且一格都沒有再寫', function () {
  const iso = '2027-11-07';
  const env = makeFillEnv({
    withGrid: false,
    weekRows: [{ SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }],
    config: { PRELUDE_DEFAULT: '預設序樂' }
  });
  const sb = env.sandbox;
  const loaded = sb.loadWeekForWebApp_(iso);
  const patch = { PAGE_TITLE: '新序樂' };
  const payload = { isoDate: iso, lastSavedAt: loaded.lastSavedAt, week: patch, baseWeek: sb.baseWeekFor_(loaded.week, patch), dutyEdits: [] };

  const first = sb.apiSaveWeek(JSON.parse(JSON.stringify(payload)));
  assert.strictEqual(first.ok, true, JSON.stringify(first.error));
  const auditAfterFirst = sb.readSheet('AuditLog').length;
  const weekAfterFirst = JSON.stringify(sb.readSheet('BulletinWeeks'));

  // 前端收到 502、表單保留、幹事再按一次「儲存」：送出的是同一份 payload。
  const second = sb.apiSaveWeek(JSON.parse(JSON.stringify(payload)));
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error.code, 'STALE');
  assert.ok(second.error.message.indexOf('這一週的資料在你載入之後被改過') === 0, second.error.message);
  assert.ok(EXPECTED_SAVE_MESSAGE.indexOf('「這一週的資料在你載入之後被改過」') !== -1, '前端那一句引用的字眼要與伺服器的一致');
  assert.strictEqual(sb.readSheet('AuditLog').length, auditAfterFirst, '第二次一格都沒有寫');
  assert.strictEqual(JSON.stringify(sb.readSheet('BulletinWeeks')), weekAfterFirst);
});

// =====================================================================
// G23：apiSaveWeek 由讀取、比對到寫入 LAST_SAVED_AT 都在指令碼鎖之內
// =====================================================================

console.log('\n儲存要拿指令碼鎖（G23）');

/** 一個可以儲存的主日（真正的工作表結構，經 makeFillEnv）。 */
function makeSaveEnv(extraStubs) {
  const iso = '2027-11-07';
  const env = makeFillEnv({
    withGrid: false,
    weekRows: [{ SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }],
    config: { PRELUDE_DEFAULT: '預設序樂' },
    extraStubs: extraStubs
  });
  const sb = env.sandbox;
  const loaded = sb.loadWeekForWebApp_(iso);
  const patch = { PAGE_TITLE: '新序樂' };
  const payload = { isoDate: iso, lastSavedAt: loaded.lastSavedAt, week: patch, baseWeek: sb.baseWeekFor_(loaded.week, patch), dutyEdits: [] };
  return { sb: sb, iso: iso, payload: payload };
}

/**
 * 第一次儲存讀完、比對完樂觀鎖，正要存版本、寫欄位（trySnapshotWeek_() 那一刻）時，第二次
 * 儲存送到伺服器——正正是連線錯誤之後即時再按「儲存」、第一次仍在跑的情況。
 */
function saveWithSecondDuringFirst(env) {
  const sb = env.sb;
  const original = sb.trySnapshotWeek_;
  const seen = {};
  sb.trySnapshotWeek_ = function () {
    if (!seen.started) {
      seen.started = true;
      seen.lastSavedAtAtThatMoment = sb.readSheet('BulletinWeeks')[0].LAST_SAVED_AT;
      seen.preludeAtThatMoment = sb.readSheet('BulletinWeeks')[0].PAGE_TITLE;
      // D12：第二次儲存是另一次執行（另一個 google.script.run），模組層的鎖計數是它自己的一份。
      seen.second = asOtherExecution(sb, function () { return sb.apiSaveWeek(JSON.parse(JSON.stringify(env.payload))); });
    }
    return original.apply(this, arguments);
  };
  seen.first = sb.apiSaveWeek(JSON.parse(JSON.stringify(env.payload)));
  sb.trySnapshotWeek_ = original;
  return seen;
}

/**
 * D12：在同一個 sandbox 之內模擬「另一次執行」。Apps Script 每一次執行都由頭載入全部 .gs，模組層的
 * SCRIPT_LOCK_DEPTH_（src/ScriptLock.gs）每次都是 0；Node 測試只有一個 sandbox，要另一次執行的話
 * 先把它設成 0，做完再還原——否則會被當成同一次執行的巢狀呼叫，不再等鎖。
 */
function asOtherExecution(sb, fn) {
  const saved = sb.SCRIPT_LOCK_DEPTH_;
  sb.SCRIPT_LOCK_DEPTH_ = 0;
  try {
    return fn();
  } finally {
    sb.SCRIPT_LOCK_DEPTH_ = saved;
  }
}

function auditOf(sb, action) {
  return sb.readSheet('AuditLog').filter(function (r) { return r.ACTION === action; });
}

test('G23-1 第一次儲存拿着鎖、未寫 LAST_SAVED_AT 時第二次儲存到達 → 第二次拿不到鎖，回清楚的一句，一格都沒有寫；第一次照常完成', function () {
  const env = makeSaveEnv();
  const seen = saveWithSecondDuringFirst(env);
  assert.ok(!seen.lastSavedAtAtThatMoment, '前提：那一刻 LAST_SAVED_AT 仍未寫（沒有鎖的話第二次會通過樂觀鎖）');
  assert.notStrictEqual(seen.preludeAtThatMoment, '新序樂', '前提：那一刻欄位仍未寫');
  assert.strictEqual(seen.first.ok, true, JSON.stringify(seen.first.error));
  assert.strictEqual(seen.second.ok, false);
  assert.strictEqual(seen.second.error.code, 'LOCK_TIMEOUT');
  assert.strictEqual(seen.second.error.message,
    '另一個寫入動作（例如另一次儲存、匯入或發佈）正在執行中，30 秒內等不到，所以這一次一格都沒有寫。你的改動仍在畫面上，請稍等再按「儲存」。');
  assert.strictEqual(auditOf(env.sb, 'WEBAPP_SAVE_WEEK').length, 1, 'AuditLog 只有第一次那一筆');
  assert.strictEqual(auditOf(env.sb, 'WEEK_SNAPSHOT_CREATE').length, 1, '版本只存了一個');
  assert.strictEqual(env.sb.readSheet('BulletinWeeks')[0].PAGE_TITLE, '新序樂');
  assert.strictEqual(env.sb.LockService.held(), false, '第一次完成之後放鎖');
  assertWrittenChinese(assert, 'G23 拿不到鎖', [seen.second.error.message]);
});

test('G23-2 第二次等到鎖（第一次已經寫完）→ 回 STALE，一格都沒有再寫', function () {
  const env = makeSaveEnv();
  const first = env.sb.apiSaveWeek(JSON.parse(JSON.stringify(env.payload)));
  assert.strictEqual(first.ok, true);
  const auditAfterFirst = env.sb.readSheet('AuditLog').length;
  const second = env.sb.apiSaveWeek(JSON.parse(JSON.stringify(env.payload)));
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error.code, 'STALE');
  assert.strictEqual(env.sb.readSheet('AuditLog').length, auditAfterFirst);
  assert.strictEqual(env.sb.LockService.held(), false, 'STALE（鎖之內拋錯）之後一樣放鎖');
  // 放了鎖，之後正常的儲存照樣做得到。
  const loaded = env.sb.loadWeekForWebApp_(env.iso);
  const patch = { PAGE_TITLE: '再改一次' };
  const third = env.sb.apiSaveWeek({ isoDate: env.iso, lastSavedAt: loaded.lastSavedAt, week: patch, baseWeek: env.sb.baseWeekFor_(loaded.week, patch), dutyEdits: [] });
  assert.strictEqual(third.ok, true, JSON.stringify(third.error));
});

test('G23-3 對照（證明 G23-1 量得到）：鎖一定拿得到（等於沒有鎖）的話，同一時刻的第二次儲存通過樂觀鎖，AuditLog 與版本重複', function () {
  const alwaysFree = { getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } };
  const env = makeSaveEnv({ LockService: alwaysFree });
  const seen = saveWithSecondDuringFirst(env);
  assert.strictEqual(seen.first.ok, true);
  assert.strictEqual(seen.second.ok, true, '沒有鎖：第二次讀到舊的 LAST_SAVED_AT，照樣通過');
  assert.strictEqual(auditOf(env.sb, 'WEBAPP_SAVE_WEEK').length, 2, '沒有鎖：AuditLog 重複');
  assert.strictEqual(auditOf(env.sb, 'WEEK_SNAPSHOT_CREATE').length, 2, '沒有鎖：版本重複');
});

test('G23b-1 放鎖之前先 SpreadsheetApp.flush()：儲存（真正入口 apiSaveWeek）的次序是 tryLock → 寫入 → flush → releaseLock；STALE 時亦一樣', function () {
  const events = [];
  const recordingLock = { getScriptLock: function () {
    return {
      tryLock: function () { events.push('tryLock'); return true; },
      releaseLock: function () { events.push('releaseLock'); }
    };
  } };
  const env = makeSaveEnv({ LockService: recordingLock });
  env.sb.SpreadsheetApp.flush = function () { events.push('flush'); };
  const ok = env.sb.apiSaveWeek(JSON.parse(JSON.stringify(env.payload)));
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.error));
  assert.deepStrictEqual(events, ['tryLock', 'flush', 'releaseLock']);
  events.length = 0;
  const stale = env.sb.apiSaveWeek(JSON.parse(JSON.stringify(env.payload)));
  assert.strictEqual(stale.error.code, 'STALE');
  assert.deepStrictEqual(events, ['tryLock', 'flush', 'releaseLock']);
});

test('G23b-2 專案內拿指令碼鎖的地方全部經 withScriptLock_()（D12），它經 flushAndReleaseLock_() 放鎖；其他檔案不直接拿鎖、不直接放鎖、不碰鎖計數', function () {
  const files = fs.readdirSync(path.join(__dirname, '..', 'src')).filter(function (f) { return f.endsWith('.gs'); });
  const users = [];
  files.forEach(function (f) {
    const code = readSrc('src/' + f).split('\n').filter(function (line) {
      const t = line.trim();
      return !(t.indexOf('//') === 0 || t.indexOf('*') === 0 || t.indexOf('/*') === 0);
    }).join('\n');
    if (f === 'ScriptLock.gs') {
      assert.ok(code.indexOf('LockService.getScriptLock()') !== -1);
      assert.ok(code.indexOf('flushAndReleaseLock_(lock)') !== -1, 'ScriptLock.gs 要經 flushAndReleaseLock_() 放鎖');
      return;
    }
    assert.strictEqual(code.indexOf('getScriptLock('), -1, f + ' 不可以直接拿鎖（要經 withScriptLock_()）');
    assert.strictEqual(code.indexOf('.tryLock('), -1, f);
    assert.strictEqual(code.indexOf('.waitLock('), -1, f);
    assert.strictEqual(code.indexOf('SCRIPT_LOCK_DEPTH_'), -1, f + ' 不可以讀寫鎖計數（只准 ScriptLock.gs）');
    if (f !== 'SheetUtils.gs') assert.strictEqual(code.indexOf('.releaseLock()'), -1, f + ' 不可以直接 releaseLock()');
    if (code.indexOf('withScriptLock_(') !== -1) users.push(f);
  });
  // D12 的四處，加上 D13 的還原、重設（WeekSnapshots.gs）與由職事表重新取數（WebApp.gs）。
  ['ContentImport.gs', 'Publish.gs', 'SpeakerForm.gs', 'WebAppSave.gs', 'WeekSnapshots.gs', 'WebApp.gs'].forEach(function (f) {
    assert.ok(users.indexOf(f) !== -1, f + ' 要經 withScriptLock_()；現時：' + users.join('、'));
  });
});

test('G23b-3 複審：flush 拋錯 → 主結果不變（真正入口 apiSaveWeek 照樣回成功與原本的訊息）、鎖已放、ErrorLog 有一行 FLUSH_FAILED；以前會拋出、蓋走主結果', function () {
  const env = makeSaveEnv();
  env.sb.SpreadsheetApp.flush = function () { throw new Error('Service Spreadsheets failed while accessing document'); };
  const resp = env.sb.apiSaveWeek(JSON.parse(JSON.stringify(env.payload)));
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  assert.strictEqual(resp.data.message.text, '已儲存，更新了 1 個欄位。', '主結果照原樣');
  assert.strictEqual(env.sb.LockService.held(), false, '鎖已放');
  const errors = env.sb.readSheet('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'FLUSH_FAILED'; });
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].FUNCTION_NAME, 'flushAndReleaseLock_');
  assert.ok(errors[0].MESSAGE.indexOf('Service Spreadsheets failed') !== -1, errors[0].MESSAGE);
  assertWrittenChinese(assert, 'FLUSH_FAILED', [errors[0].MESSAGE.split('：')[0]]);

  // 直接叫：不拋出，鎖照放。
  let released = false;
  assert.doesNotThrow(function () { env.sb.flushAndReleaseLock_({ releaseLock: function () { released = true; } }); });
  assert.strictEqual(released, true);
});

test('G23-4 只有一種鎖：儲存用的是指令碼鎖，等候時間與內容表匯入、講員表格相同（30 秒）', function () {
  const env = makeSaveEnv();
  assert.strictEqual(env.sb.SAVE_LOCK_WAIT_MS_, 30000);
  const src = readSrc('src/WebAppSave.gs');
  assert.ok(src.indexOf('LockService.getScriptLock()') !== -1);
  assert.strictEqual(src.indexOf('getDocumentLock'), -1);
  assert.strictEqual(src.indexOf('getUserLock'), -1);
  assert.ok(readSrc('src/ContentImport.gs').indexOf("withScriptLock_('applyContentImport_', 30000,") !== -1, '對照：內容表匯入等 30 秒');
});

// =====================================================================
// D12：共用的鎖函式 withScriptLock_()，同一次執行之內巢狀呼叫不再等鎖、不提早放鎖
// =====================================================================

console.log('\n共用的鎖函式（D12）');

/** 一把嚴格的假鎖：同一時間只可以有一個人拿着，拿着時再 tryLock 一律失敗（不可重入），並記下每一步。 */
function strictRecordingLock(events) {
  let held = false;
  return {
    getScriptLock: function () {
      return {
        tryLock: function (ms) { events.push('tryLock:' + ms); if (held) return false; held = true; return true; },
        releaseLock: function () { events.push('releaseLock'); held = false; }
      };
    },
    held: function () { return held; }
  };
}

test('D12-1 巢狀呼叫：外層拿鎖一次；內層直接執行、不再 tryLock、不放鎖；內層做完時鎖仍然在外層手上；最外層做完才 flush 再放鎖', function () {
  const events = [];
  const env = makeSaveEnv({ LockService: strictRecordingLock(events) });
  const sb = env.sb;
  sb.SpreadsheetApp.flush = function () { events.push('flush'); };
  const seen = {};
  const out = sb.withScriptLock_('外層', 30000, function () {
    seen.depthOuter = sb.SCRIPT_LOCK_DEPTH_;
    const inner = sb.withScriptLock_('內層', 30000, function () {
      seen.depthInner = sb.SCRIPT_LOCK_DEPTH_;
      return '內層結果';
    }, function () { throw new Error('內層不應該等鎖'); });
    seen.heldAfterInner = sb.LockService.held();
    seen.heldInThisExecution = sb.scriptLockHeldInThisExecution_();
    return inner + '＋外層';
  });
  assert.strictEqual(out, '內層結果＋外層');
  assert.strictEqual(seen.depthOuter, 1);
  assert.strictEqual(seen.depthInner, 2);
  assert.strictEqual(seen.heldAfterInner, true, '內層不可以提早放鎖');
  assert.strictEqual(seen.heldInThisExecution, true);
  assert.deepStrictEqual(events, ['tryLock:30000', 'flush', 'releaseLock'], '只拿一次、只放一次');
  assert.strictEqual(sb.SCRIPT_LOCK_DEPTH_, 0);
  assert.strictEqual(sb.scriptLockHeldInThisExecution_(), false);
});

test('D12-2 內層拋錯：錯誤原樣傳出，鎖仍然由外層在最後放；外層拋錯亦一樣放鎖、計數歸零（之後再拿得到）', function () {
  const events = [];
  const env = makeSaveEnv({ LockService: strictRecordingLock(events) });
  const sb = env.sb;
  sb.SpreadsheetApp.flush = function () {};
  assert.throws(function () {
    sb.withScriptLock_('外層', 30000, function () {
      try {
        sb.withScriptLock_('內層', 30000, function () { throw new Error('內層壞了'); });
      } catch (err) {
        assert.strictEqual(sb.LockService.held(), true, '內層拋錯之後鎖仍在');
        throw err;
      }
    });
  }, /內層壞了/);
  assert.strictEqual(sb.LockService.held(), false);
  assert.strictEqual(sb.SCRIPT_LOCK_DEPTH_, 0);
  assert.strictEqual(sb.withScriptLock_('再一次', 30000, function () { return 'ok'; }), 'ok');
});

test('D12-3 拿不到鎖：onBusy 的回傳值原樣回傳（發佈的 LOCK_BUSY）或由它拋錯；沒有 onBusy 就拋 LOCK_TIMEOUT；fn 一次都沒有執行', function () {
  const events = [];
  const lock = strictRecordingLock(events);
  const env = makeSaveEnv({ LockService: lock });
  const sb = env.sb;
  sb.SpreadsheetApp.flush = function () {};
  let ran = 0;
  // 另一次執行拿着鎖（模擬：手動令假鎖變成「有人拿着」）。
  lock.getScriptLock().tryLock(1);
  const busy = sb.withScriptLock_('x', 30000, function () { ran++; }, function () { return { ok: false, reason: 'LOCK_BUSY' }; });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(busy)), { ok: false, reason: 'LOCK_BUSY' });
  assert.throws(function () { sb.withScriptLock_('x', 30000, function () { ran++; }); },
    function (err) { return err.code === 'LOCK_TIMEOUT' && err.message.indexOf('x：另一個寫入動作') === 0; });
  assert.strictEqual(ran, 0);
  assert.strictEqual(sb.SCRIPT_LOCK_DEPTH_, 0, '拿不到鎖不可以把計數加了上去');
});


// =====================================================================
// G28：由職事表重新取數要更新 LAST_SAVED_AT，否則較早載入的分頁儲存會令停用的覆寫復活
// =====================================================================

console.log('\n由職事表重新取數更新最後儲存時間（G28）');

/**
 * 一個主日，主席（職事表是陳大文）已經有一筆生效中的覆寫「李小明」（經 apiSaveWeek 造出來）。
 * 最後儲存時間撥回一個舊日子：假工作表只存到日期，同一日之內兩次寫入分不出先後。
 */
function makeOverriddenChairEnv() {
  const env = makeSaveEnv();
  const sb = env.sb;
  const created = sb.apiSaveWeek({ isoDate: env.iso, lastSavedAt: sb.loadWeekForWebApp_(env.iso).lastSavedAt,
    payloadVersion: 2, week: {}, baseWeek: {}, dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '李小明', baseName: '陳大文' }] });
  assert.strictEqual(created.ok, true, JSON.stringify(created.error));
  const rowNo = sb.readBulletinWeekRowWithRowNo_(env.iso).__rowNo;
  sb.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BulletinWeeks')
    .getRange(rowNo, sb.COLUMNS.BULLETIN_WEEKS.keys.indexOf('LAST_SAVED_AT') + 1).setValue('2026-10-01');
  return env;
}

function chairOverride(sb) {
  return sb.readSheet('DutyOverride').filter(function (r) { return r.POST_ID === 'CHAIR'; })[0];
}

test('G28-1 真正入口：分頁甲載入 → 分頁乙「由職事表重新取數」停用主席的覆寫 → 分頁甲按「儲存」（事奉框仍是舊的覆寫名字）→ STALE，覆寫沒有復活', function () {
  const env = makeOverriddenChairEnv();
  const sb = env.sb;
  const tabA = sb.loadWeekForWebApp_(env.iso);
  assert.strictEqual(chairOverride(sb).ACTIVE, true, '前提：覆寫生效中');

  const fetched = sb.apiFetchFromRoster(env.iso, [{ postId: 'CHAIR', slotIndex: 1 }]);
  assert.strictEqual(fetched.ok, true, JSON.stringify(fetched.error));
  assert.strictEqual(fetched.data.clearedCount, 1);
  assert.strictEqual(chairOverride(sb).ACTIVE, false);
  assert.notStrictEqual(sb.canonicalSaveToken_(sb.readSheet('BulletinWeeks')[0].LAST_SAVED_AT), tabA.lastSavedAt,
    '由職事表重新取數要更新最後儲存時間');

  // 分頁甲只改了序樂。D9 之後前端只送改過的格，主席那一格不送；以前整批送（主席仍是載入時的「李小明」）
  // 才會令覆寫復活。G28 的最後儲存時間照舊更新，分頁甲照舊收到 STALE（不為簡化而拿走）。
  const patch = { PAGE_TITLE: '甲改的序樂' };
  const saved = sb.apiSaveWeek({ isoDate: env.iso, lastSavedAt: tabA.lastSavedAt, payloadVersion: 2, week: patch,
    baseWeek: sb.baseWeekFor_(tabA.week, patch), dutyEdits: changedDutyCells(tabA.readOnly.dutyBoxPage1, {}) });
  assert.strictEqual(saved.ok, false);
  assert.strictEqual(saved.error.code, 'STALE');
  assert.strictEqual(chairOverride(sb).ACTIVE, false, '停用的覆寫沒有復活');
});

test('G28-2 由職事表重新取數一格都沒有停用（勾選的格本來就沒有生效中的覆寫）→ 不更新最後儲存時間', function () {
  const env = makeOverriddenChairEnv();
  const sb = env.sb;
  sb.apiFetchFromRoster(env.iso, [{ postId: 'CHAIR', slotIndex: 1 }]);
  const before = sb.readSheet('BulletinWeeks')[0].LAST_SAVED_AT;
  const rowNo = sb.readBulletinWeekRowWithRowNo_(env.iso).__rowNo;
  sb.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BulletinWeeks')
    .getRange(rowNo, sb.COLUMNS.BULLETIN_WEEKS.keys.indexOf('LAST_SAVED_AT') + 1).setValue('2026-10-02');
  // 撥回之後先讀一次作對照：假工作表把日期字串存成本機時區零時，直接與字串比較會受時區影響。
  const rewound = sb.canonicalSaveToken_(sb.readSheet('BulletinWeeks')[0].LAST_SAVED_AT);
  const again = sb.apiFetchFromRoster(env.iso, [{ postId: 'CHAIR', slotIndex: 1 }]);
  assert.strictEqual(again.data.clearedCount, 0);
  assert.ok(before, '前提：第一次有寫');
  assert.strictEqual(sb.canonicalSaveToken_(sb.readSheet('BulletinWeeks')[0].LAST_SAVED_AT), rewound, '沒有停用就不動');
});

/**
 * G28 補充：三個連續主日（W-7、W、W+7），最後儲存時間都撥回舊日子，分頁都在任何改動之前載入。
 */
function makeThreeWeekEnv() {
  const dates = ['2027-11-07', '2027-11-14', '2027-11-21'];
  const env = makeFillEnv({
    withGrid: false,
    weekRows: dates.map(function (iso, i) {
      return { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: i + 1, STATUS: 'DRAFT', LAST_SAVED_AT: '2026-10-01' };
    }),
    config: { PRELUDE_DEFAULT: '預設序樂' }
  });
  const sb = env.sandbox;
  const tabs = {};
  dates.forEach(function (iso) { tabs[iso] = sb.loadWeekForWebApp_(iso); });
  return { sb: sb, before: dates[0], week: dates[1], after: dates[2], tabs: tabs };
}

/**
 * 某一個分頁改序樂，兩個事奉框的主席是畫面上的 chairName／nextChairName。D9：照前端那樣只送與它載入時
 * 不同的格（以前整批送，見 FF-17）；名字與載入時相同就等於沒有改那一格。
 */
function saveFromStaleTab(env, iso, chairName, nextChairName) {
  const tab = env.tabs[iso];
  const patch = { PAGE_TITLE: iso + ' 改的序樂' };
  return env.sb.apiSaveWeek({ isoDate: iso, lastSavedAt: tab.lastSavedAt, payloadVersion: 2, week: patch,
    baseWeek: env.sb.baseWeekFor_(tab.week, patch),
    dutyEdits: changedDutyCells(tab.readOnly.dutyBoxPage1, { 'CHAIR#1': chairName }),
    nextWeekDutyEdits: changedDutyCells(tab.readOnly.nextWeekDuty, { 'CHAIR#1': nextChairName }) });
}

function activeChairOn(sb, iso) {
  const row = sb.readSheet('DutyOverride').filter(function (r) {
    return r.POST_ID === 'CHAIR' && sb.formatIsoDate_(sb.normalizeDate_(r.SERVICE_DATE)) === iso;
  })[0];
  return row && row.ACTIVE === true ? row.OVERRIDE_NAME : null;
}

test('G28-3 W 的「下週事奉」把 W+7 的主席改成「下週主席」→ W+7 較早載入的分頁儲存（本週事奉仍是陳大文）→ STALE，W 的改動沒有被蓋走', function () {
  const env = makeThreeWeekEnv();
  const r = saveFromStaleTab(env, env.week, '陳大文', '下週主席');
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(activeChairOn(env.sb, env.after), '下週主席', '前提');
  const stale = saveFromStaleTab(env, env.after, '陳大文', '陳大文');
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.error.code, 'STALE');
  assert.strictEqual(activeChairOn(env.sb, env.after), '下週主席');
});

test('G28-4 W 的「本週事奉」把主席改成「臨時主席」→ W-7 較早載入的分頁儲存（下週事奉仍是陳大文）→ STALE；只更新對照基準不會令另一週 STALE', function () {
  const env = makeThreeWeekEnv();
  saveFromStaleTab(env, env.week, '臨時主席', '陳大文');
  assert.strictEqual(activeChairOn(env.sb, env.week), '臨時主席', '前提');
  const stale = saveFromStaleTab(env, env.before, '陳大文', '陳大文');
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.error.code, 'STALE');
  assert.strictEqual(activeChairOn(env.sb, env.week), '臨時主席');

  assert.strictEqual(env.sb.dutyPlanChangesNames_({ updates: [{ changes: [{ field: 'ROSTER_VERSION_AT_OVERRIDE' }] }], appends: [], deactivations: [] }), false);
  assert.strictEqual(env.sb.dutyPlanChangesNames_({ updates: [{ changes: [{ field: 'OVERRIDE_NAME' }] }], appends: [], deactivations: [] }), true);
  assert.strictEqual(env.sb.dutyPlanChangesNames_(null), false);
});

test('G28-5 W「由職事表重新取數」停用主席的覆寫 → W-7 較早載入的分頁儲存（下週事奉仍是舊覆寫名字）→ STALE，覆寫沒有復活', function () {
  const env = makeThreeWeekEnv();
  saveFromStaleTab(env, env.week, '臨時主席', '陳大文');
  // W-7 在覆寫之後、取數之前載入。
  const sb = env.sb;
  const rowNo = sb.readBulletinWeekRowWithRowNo_(env.before).__rowNo;
  sb.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BulletinWeeks')
    .getRange(rowNo, sb.COLUMNS.BULLETIN_WEEKS.keys.indexOf('LAST_SAVED_AT') + 1).setValue('2026-10-02');
  env.tabs[env.before] = sb.loadWeekForWebApp_(env.before);
  const fetched = sb.apiFetchFromRoster(env.week, [{ postId: 'CHAIR', slotIndex: 1 }]);
  assert.strictEqual(fetched.data.clearedCount, 1);
  const stale = saveFromStaleTab(env, env.before, '陳大文', '臨時主席');
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.error.code, 'STALE');
  assert.strictEqual(activeChairOn(sb, env.week), null, '覆寫沒有復活');
});

test('G28-6 「重設這一週」W 停用主席的覆寫 → W-7 較早載入的分頁儲存 → STALE，覆寫沒有復活（還原同一做法）', function () {
  const env = makeThreeWeekEnv();
  const sb = env.sb;
  saveFromStaleTab(env, env.week, '臨時主席', '陳大文');
  const rowNo = sb.readBulletinWeekRowWithRowNo_(env.before).__rowNo;
  sb.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BulletinWeeks')
    .getRange(rowNo, sb.COLUMNS.BULLETIN_WEEKS.keys.indexOf('LAST_SAVED_AT') + 1).setValue('2026-10-02');
  env.tabs[env.before] = sb.loadWeekForWebApp_(env.before);
  const reset = sb.apiResetWeek({ isoDate: env.week, lastSavedAt: sb.loadWeekForWebApp_(env.week).lastSavedAt });
  assert.strictEqual(reset.ok, true, JSON.stringify(reset.error));
  assert.strictEqual(activeChairOn(sb, env.week), null, '前提：重設停用了覆寫');
  const stale = saveFromStaleTab(env, env.before, '陳大文', '臨時主席');
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.error.code, 'STALE');
  assert.strictEqual(activeChairOn(sb, env.week), null);
  // 複審 3 改了寫法（W 剛剛已經寫了，只列 W-7）；還原與重設兩處都要有。
  assert.ok(readSrc('src/WeekSnapshots.gs').split('touchWeeksLastSavedAt_(weeksShowingDuty_([isoDate], [isoDate]), stamp)').length - 1 === 2,
    '還原與重設兩處都有');
});

/** 職事表把某一個主日的主席改成另一個人（職事表那邊改了人；只讀週報的假職事表，不經 src）。 */
function rosterChangesChair(sb, rowNo, personId, name) {
  const roster = sb.SpreadsheetApp.openById('FAKE_ROSTER_ID_FOR_FILL_TESTS');
  const sh = roster.getSheetByName('RosterAssignments');
  const keys = sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.getRange(rowNo, keys.indexOf('PersonID') + 1).setValue(personId);
  sh.getRange(rowNo, keys.indexOf('PersonNameSnapshot') + 1).setValue(name);
  const nm = roster.getSheetByName('NameMapping');
  const nk = nm.getRange(2, 1, 1, nm.getLastColumn()).getValues()[0];
  nm.getRange(nm.getLastRow() + 1, 1, 1, nk.length).setValues([nk.map(function (k) {
    return k === 'PersonID' ? personId : k === 'NameTC' ? name : k === 'Active' ? true : '';
  })]);
}

test('G28-7 複審：W 的主席覆寫是「李小明」，職事表之後亦改成李小明；W 只改序樂儲存 → 後端停用那筆覆寫但畫面名字不變 → 不更新 W-7，W-7 較早載入的分頁儲存不會收到 STALE', function () {
  const env = makeThreeWeekEnv();
  const sb = env.sb;
  saveFromStaleTab(env, env.week, '李小明', '陳大文');
  assert.strictEqual(activeChairOn(sb, env.week), '李小明', '前提：覆寫生效中');
  rosterChangesChair(sb, 4, 'P9002', '李小明');   // 第 4 行是 2027-11-14
  sb.ROSTER_TABLES_CACHE_ = null;                 // 下一次執行：同一次執行內的職事表快取不跨執行
  // W-7 與 W 在職事表追上之後重新載入（最後儲存時間撥回舊日子，同一日之內分不出先後）。
  [env.before, env.week].forEach(function (iso) {
    const rowNo = sb.readBulletinWeekRowWithRowNo_(iso).__rowNo;
    sb.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BulletinWeeks')
      .getRange(rowNo, sb.COLUMNS.BULLETIN_WEEKS.keys.indexOf('LAST_SAVED_AT') + 1).setValue('2026-10-02');
    env.tabs[iso] = sb.loadWeekForWebApp_(iso);
  });

  const wSave = saveFromStaleTab(env, env.week, '李小明', '陳大文');
  assert.strictEqual(wSave.ok, true, JSON.stringify(wSave.error));
  assert.strictEqual(activeChairOn(sb, env.week), null, '前提：後端停用了那筆覆寫（名字與職事表相同）');
  const before = saveFromStaleTab(env, env.before, '陳大文', '李小明');
  assert.strictEqual(before.ok, true, 'W-7 不應收到 STALE：' + JSON.stringify(before.error));

  // 規則只有一份：G16 的 displayUnchanged 與這裏用同一支。
  assert.strictEqual(sb.dutyDeactivationKeepsDisplay_({ oldValue: '李小明', rosterName: '李小明' }), true);
  assert.strictEqual(sb.dutyDeactivationKeepsDisplay_({ oldValue: '李小明', rosterName: '陳大文' }), false);
  assert.strictEqual(sb.dutyDeactivationKeepsDisplay_({ oldValue: '李小明' }), false, '重設、還原的計畫沒有 rosterName：當作會變');
  assert.strictEqual(sb.dutyPlanChangesNames_({ appends: [], updates: [], deactivations: [{ oldValue: '李小明', rosterName: '李小明' }] }), false);
  assert.strictEqual(sb.dutyPlanChangesNames_({ appends: [], updates: [], deactivations: [{ oldValue: '李小明' }] }), true);
  assert.ok(readSrc('src/DutyOverride.gs').indexOf('displayUnchanged: dutyDeactivationKeepsDisplay_(deact)') !== -1);
});

test('G28-8 複審 3：儲存同時改了本週與下週事奉 → W 的 LAST_SAVED_AT 只寫一次，W-7 與 W+7 各寫一次，而且共用一次讀取', function () {
  const env = makeThreeWeekEnv();
  const sb = env.sb;
  const rowOf = {};
  [env.before, env.week, env.after].forEach(function (iso) { rowOf[sb.readBulletinWeekRowWithRowNo_(iso).__rowNo] = iso; });
  const writes = [];
  const touchCalls = [];
  const origWrite = sb.writeWeekCell_;
  const origTouch = sb.touchWeeksLastSavedAt_;
  sb.writeWeekCell_ = function (rowNo, key) {
    if (key === 'LAST_SAVED_AT') writes.push(rowOf[rowNo]);
    return origWrite.apply(this, arguments);
  };
  sb.touchWeeksLastSavedAt_ = function (isoDates) {
    touchCalls.push(JSON.parse(JSON.stringify(isoDates)));
    return origTouch.apply(this, arguments);
  };
  const r = saveFromStaleTab(env, env.week, '臨時主席', '下週主席');
  sb.writeWeekCell_ = origWrite;
  sb.touchWeeksLastSavedAt_ = origTouch;
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.deepStrictEqual(writes.slice().sort(), [env.before, env.week, env.after].sort(), '每週一次');
  assert.deepStrictEqual(touchCalls, [[env.before, env.after]], '一次讀取，W 不在內');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.weeksShowingDuty_([env.week, env.after], [env.week]))), [env.before, env.after]);
  assert.strictEqual(sb.touchWeeksLastSavedAt_([], new Date()), 0, '空清單不讀');
});

// =====================================================================
// D13：還原、重設、由職事表重新取數亦拿同一把鎖
// =====================================================================

console.log('\n還原、重設、由職事表重新取數拿同一把鎖（D13）');

/** 整個試算表（週報自己的全部工作表）的內容，用來斷言「一格都沒有寫」。 */
function wholeBook(sb) {
  const out = {};
  Object.keys(sb.SHEETS).forEach(function (id) {
    try { out[id] = sb.readSheet(sb.SHEETS[id]); } catch (err) { out[id] = 'ERR'; }
  });
  return JSON.stringify(out);
}

/** 另一次執行拿着鎖（例如另一個分頁的儲存、匯入或發佈仍在跑）：這一次 tryLock 一定失敗。 */
function lockHeldByOtherExecution(sb, events) {
  sb.LockService = {
    getScriptLock: function () {
      return { tryLock: function (ms) { events.push('tryLock:' + ms); return false; }, releaseLock: function () { events.push('releaseLock'); } };
    }
  };
}

const D13_BUSY_HEAD = '另一個寫入動作（例如另一次儲存、匯入或發佈）正在執行中，30 秒內等不到，所以這一次一格都沒有寫。';

test('D13-1 還原（真正入口 apiRestoreWeekSnapshot）：另一個寫入持鎖 → LOCK_TIMEOUT、清楚的一句、一格都沒有寫（連安全版本都不存）；鎖等 30 秒', function () {
  const env = makeOverriddenChairEnv();
  const sb = env.sb;
  const target = sb.listWeekSnapshotsForWebApp_(env.iso).versions[0];
  const diff = sb.diffWeekSnapshotForWebApp_(env.iso, target.snapshotId);
  const before = wholeBook(sb);
  const events = [];
  lockHeldByOtherExecution(sb, events);
  const resp = sb.apiRestoreWeekSnapshot({ isoDate: env.iso, snapshotId: target.snapshotId, lastSavedAt: diff.lastSavedAt });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'LOCK_TIMEOUT');
  assert.strictEqual(resp.error.message, D13_BUSY_HEAD + '請稍等再按「還原到這個版本」。');
  assert.deepStrictEqual(events, ['tryLock:30000']);
  const after = JSON.parse(wholeBook(sb));
  const was = JSON.parse(before);
  Object.keys(was).forEach(function (k) {
    if (k === 'ERROR_LOG') return;   // FF-22：LOCK_TIMEOUT 記一行 ErrorLog（IT 要看得到），不算週報資料
    assert.strictEqual(JSON.stringify(after[k]), JSON.stringify(was[k]), k + ' 不可以有改動');
  });
  assertWrittenChinese(assert, 'D13 還原', [resp.error.message]);
});

test('D13-2 重設（真正入口 apiResetWeek）：另一個寫入持鎖 → LOCK_TIMEOUT、一格都沒有寫', function () {
  const env = makeOverriddenChairEnv();
  const sb = env.sb;
  const loaded = sb.loadWeekForWebApp_(env.iso);
  const before = JSON.parse(wholeBook(sb));
  lockHeldByOtherExecution(sb, []);
  const resp = sb.apiResetWeek({ isoDate: env.iso, lastSavedAt: loaded.lastSavedAt });
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'LOCK_TIMEOUT');
  assert.strictEqual(resp.error.message, D13_BUSY_HEAD + '請稍等再按「重設這一週…」。');
  const after = JSON.parse(wholeBook(sb));
  Object.keys(before).forEach(function (k) {
    if (k === 'ERROR_LOG') return;
    assert.strictEqual(JSON.stringify(after[k]), JSON.stringify(before[k]), k + ' 不可以有改動');
  });
  assert.strictEqual(chairOverride(sb).ACTIVE, true, '覆寫沒有被停用');
});

test('D13-3 由職事表重新取數（真正入口 apiFetchFromRoster）：另一個寫入持鎖 → LOCK_TIMEOUT、一格都沒有寫；沒有勾選任何欄位照舊不拿鎖', function () {
  const env = makeOverriddenChairEnv();
  const sb = env.sb;
  const before = JSON.parse(wholeBook(sb));
  const events = [];
  lockHeldByOtherExecution(sb, events);
  const resp = sb.apiFetchFromRoster(env.iso, [{ postId: 'CHAIR', slotIndex: 1 }]);
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'LOCK_TIMEOUT');
  assert.strictEqual(resp.error.message, D13_BUSY_HEAD + '請稍等再按一次「以職事表覆寫我的修改…」。');
  const after = JSON.parse(wholeBook(sb));
  Object.keys(before).forEach(function (k) {
    if (k === 'ERROR_LOG') return;
    assert.strictEqual(JSON.stringify(after[k]), JSON.stringify(before[k]), k + ' 不可以有改動');
  });
  assert.strictEqual(chairOverride(sb).ACTIVE, true);
  events.length = 0;
  const none = sb.apiFetchFromRoster(env.iso, []);
  assert.strictEqual(none.ok, true);
  assert.deepStrictEqual(events, [], '沒有勾選就不拿鎖');
});

test('D13-4 真的同一刻：儲存拿着鎖、正要寫入時，另一次執行按「重設這一週」→ 重設拿不到鎖、一格都不寫；儲存照常完成；之後再按重設就做得到', function () {
  const env = makeSaveEnv();
  const sb = env.sb;
  const original = sb.trySnapshotWeek_;
  const seen = {};
  sb.trySnapshotWeek_ = function () {
    if (!seen.started) {
      seen.started = true;
      seen.reset = asOtherExecution(sb, function () { return sb.apiResetWeek({ isoDate: env.iso }); });
      seen.resetVersions = sb.listWeekSnapshotsForWebApp_(env.iso).versions.length;
    }
    return original.apply(this, arguments);
  };
  const saved = sb.apiSaveWeek(JSON.parse(JSON.stringify(env.payload)));
  sb.trySnapshotWeek_ = original;
  assert.strictEqual(saved.ok, true, JSON.stringify(saved.error));
  assert.strictEqual(seen.reset.ok, false);
  assert.strictEqual(seen.reset.error.code, 'LOCK_TIMEOUT');
  assert.strictEqual(seen.resetVersions, 0, '重設連安全版本都沒有存');
  assert.strictEqual(auditOf(sb, 'WEEK_RESET').length, 0);
  assert.strictEqual(sb.readSheet('BulletinWeeks')[0].PAGE_TITLE, '新序樂', '儲存照常完成');
  assert.strictEqual(sb.LockService.held(), false);
  const later = sb.apiResetWeek({ isoDate: env.iso });
  assert.strictEqual(later.ok, true, JSON.stringify(later.error));
  // v3：重設把大標題改回 Config 的 DEFAULT_PAGE_TITLE（沒有填就是「崇拜程序」）。
  assert.strictEqual(sb.readSheet('BulletinWeeks')[0].PAGE_TITLE, '崇拜程序');
});

test('D13-5 還原、重設、由職事表重新取數成功時各拿一次鎖、放一次鎖（經 withScriptLock_()，flush 之後才放）', function () {
  const env = makeOverriddenChairEnv();
  const sb = env.sb;
  const events = [];
  sb.LockService = {
    getScriptLock: function () {
      return { tryLock: function (ms) { events.push('tryLock:' + ms); return true; }, releaseLock: function () { events.push('releaseLock'); } };
    }
  };
  sb.SpreadsheetApp.flush = function () { events.push('flush'); };
  const fetched = sb.apiFetchFromRoster(env.iso, [{ postId: 'CHAIR', slotIndex: 1 }]);
  assert.strictEqual(fetched.ok, true, JSON.stringify(fetched.error));
  assert.deepStrictEqual(events.splice(0), ['tryLock:30000', 'flush', 'releaseLock']);
  const reset = sb.apiResetWeek({ isoDate: env.iso });
  assert.strictEqual(reset.ok, true, JSON.stringify(reset.error));
  assert.deepStrictEqual(events.splice(0), ['tryLock:30000', 'flush', 'releaseLock']);
  const target = sb.listWeekSnapshotsForWebApp_(env.iso).versions[0];
  const restored = sb.apiRestoreWeekSnapshot({ isoDate: env.iso, snapshotId: target.snapshotId });
  assert.strictEqual(restored.ok, true, JSON.stringify(restored.error));
  assert.deepStrictEqual(events.splice(0), ['tryLock:30000', 'flush', 'releaseLock']);
  assert.strictEqual(sb.SCRIPT_LOCK_DEPTH_, 0);
});

// =====================================================================
// G15：重設與還原對話框按「取消」
// =====================================================================

console.log('\n重設與還原對話框按「取消」（G15）');

const CANCELLED = '已取消，一格都沒有寫。';

test('G15-1 「重設這一週」→ 對話框按「取消」→ 頁頂顯示「已取消，一格都沒有寫。」，沒有送出 apiResetWeek', function () {
  const ui = makeUi();
  ui.click('resetWeekBtn');
  assert.strictEqual(ui.els.confirmDialogBackdrop.classList.contains('hidden'), false, '前提：確認對話框打開了');
  ui.click('confirmCancelBtn');
  assert.strictEqual(ui.els.confirmDialogBackdrop.classList.contains('hidden'), true);
  assert.deepStrictEqual(ui.message(), { type: 'info', text: CANCELLED });
  assert.strictEqual(ui.count('apiResetWeek'), 0);
});

test('G15-2 「還原到這個版本」→ 對話框按「取消」或 Esc → 同一句，沒有送出 apiRestoreWeekSnapshot', function () {
  const ui = makeUi();
  clickRestoreButton(ui, 'SNAP-1');
  ui.take('apiDiffWeekSnapshot').ok(DIFF_OK);
  ui.click('confirmCancelBtn');
  assert.deepStrictEqual(ui.message(), { type: 'info', text: CANCELLED });
  assert.strictEqual(ui.count('apiRestoreWeekSnapshot'), 0);

  const ui2 = makeUi();
  clickRestoreButton(ui2, 'SNAP-2');
  ui2.take('apiDiffWeekSnapshot').ok(DIFF_OK);
  ui2.dom.docListeners.keydown({ key: 'Escape' });
  assert.deepStrictEqual(ui2.message(), { type: 'info', text: CANCELLED });
  assert.strictEqual(ui2.count('apiRestoreWeekSnapshot'), 0);
});

test('G15-3 與「更新本季內容表…」同一個常數：按「取消」顯示一字不差的一句；Script.html 內這句只寫一次', function () {
  // v3：季度作業區塊已經拿走，改驗取代它的「更新本季內容表…」。
  const ui = makeUi({ extra: [['function startContentSheetUpgrade(', 'function onContentImportDone(']] });
  ui.ctx.startContentSheetUpgrade();
  ui.take('apiPreviewContentSheetBuild').ok({ ok: true, data: { ok: true, lines: ['會加上新的欄。'] } });
  ui.click('confirmCancelBtn');
  assert.deepStrictEqual(ui.message(), { type: 'info', text: CANCELLED });
  assert.strictEqual(ui.count('apiRunContentSheetBuild'), 0);
  assert.strictEqual(ui.ctx.CANCELLED_NOTHING_WRITTEN_MESSAGE, CANCELLED);
  const js = readSrc('src/ui/Script.html');
  assert.strictEqual(js.split(CANCELLED).length - 1, 1, '字眼只可以在常數那一處');
});

test('G19-1（2026-10-28 Ivan 測試結果 B 第 1 項改）「由內容表匯入」不再先預覽、不再問：直接送 apiRunContentImport，不打開確認對話框；完成後只講一句', function () {
  const ui = makeUi({ extra: [['function startContentImport(', 'function applyBaptismPanelVisibility(']] });
  ui.ctx.startContentImport();
  assert.strictEqual(ui.count('apiPreviewContentImport'), 0, '不再先預覽');
  assert.strictEqual(ui.count('apiRunContentImport'), 1, '直接匯入');
  assert.strictEqual(ui.els.confirmDialogBackdrop.classList.contains('hidden'), true, '沒有確認對話框');
  ui.take('apiRunContentImport').ok({ ok: true, data: { ok: true,
    summary: { added: 0, updated: 0, removed: 0, releases: 0, noChangeMessage: '內容表與週報現況一致，沒有任何改動。' },
    lines: ['', '', ''] } });
  assert.deepStrictEqual(ui.message(), { type: 'info', text: '內容表與週報現況一致，沒有任何改動。' });
});

// 內容表 v2：G19-2（「建立講員表格」按取消）拿走——講員表格已停用，那個對話框已不存在。

test('G19-3 「由職事表重新取數」對話框、發佈前檢查視窗按「取消」→ 同一句，對話框關閉，沒有送出寫入請求', function () {
  const ui = makeUi();
  const fetchDialog = ui.dom.document.getElementById('fetchDialogBackdrop');
  fetchDialog.classList.remove('hidden');
  ui.click('fetchCancelBtn');
  assert.strictEqual(fetchDialog.classList.contains('hidden'), true);
  assert.deepStrictEqual(ui.message(), { type: 'info', text: CANCELLED });
  assert.strictEqual(ui.count('apiFetchFromRoster'), 0);

  const pub = makeUi();
  pub.ctx.openPublishConfirm(['未填欄位（3 項）'], { title: '發佈前檢查', checkbox: '仍然要發佈', confirmButton: '確認發佈' });
  assert.strictEqual(pub.els.publishConfirmBackdrop.classList.contains('hidden'), false, '前提：視窗打開了');
  pub.click('publishConfirmCancelBtn');
  assert.strictEqual(pub.els.publishConfirmBackdrop.classList.contains('hidden'), true);
  assert.deepStrictEqual(pub.message(), { type: 'info', text: CANCELLED });
  assert.strictEqual(pub.count('apiRunPublish'), 0);
});

test('G19-4 Script.html 內每一個 openConfirmDialog() 的取消分支：會寫入的都用 CANCELLED_NOTHING_WRITTEN_MESSAGE；只有換週與由職事表重新取數（審查後修正 7）例外（不是寫入）', function () {
  const js = readSrc('src/ui/Script.html');
  const titles = [];
  // 註解內的「openConfirmDialog()」與函式定義本身不算呼叫。
  const re = /openConfirmDialog\((?!\))([^,]+),/g;
  let m;
  while ((m = re.exec(js)) !== null) {
    if (js.slice(m.index - 9, m.index) === 'function ') continue;
    // v3：三選一對話框 openChoiceDialog() 內部經 openConfirmDialog(title, …)，取消分支交回呼叫者（只有「下載 Word」，不是寫入）。
    if (m[1].trim() === 'title') continue;
    const callback = js.slice(m.index, js.indexOf('callServer(', m.index) === -1 ? m.index + 400 : js.indexOf('callServer(', m.index));
    titles.push(m[1].trim());
    if (m[1].indexOf("'換週'") !== -1 || m[1].indexOf("'重新讀取職事表'") !== -1) {
      assert.ok(callback.indexOf('CANCELLED_NOTHING_WRITTEN_MESSAGE') === -1, m[1] + ' 不是寫入，不用「一格都沒有寫」');
      continue;
    }
    assert.ok(callback.indexOf('CANCELLED_NOTHING_WRITTEN_MESSAGE') !== -1, m[1] + ' 的取消分支要用共用常數');
  }
  // 內容表 v2：「建立講員表格」隨講員表格停用拿走。
  // v3：季度作業拿走；加「更新本季內容表」；「重讀職事表」改名「由職事表重新取數」。
  // 2026-10-30：加「建立特別崇拜」。
  assert.deepStrictEqual(titles, ["'由內容表匯入'", "'更新本季內容表'", "'還原到這個版本'", "'重設這一週'", "'換週'", "'重新讀取職事表'",
    "'建立特別崇拜'"],
    '對話框有增減：先檢查取消分支，再更新這裏');
  // 三選一對話框只有「下載 Word」一處，取消甚麼都不做（不是寫入，不講「一格都沒有寫」）。
  // 2026-10-28：加「開啟預覽」（Word 預覽，有未儲存修改時問用哪一個版本；取消甚麼都不做）。
  assert.deepStrictEqual((js.match(/openChoiceDialog\('[^']+'/g) || []), ["openChoiceDialog('下載 Word'", "openChoiceDialog('開啟預覽'"]);
  assert.strictEqual(js.indexOf('已取消，沒有寫入任何資料。'), -1, '舊字眼不再出現');
});

test('G15-4 對話框按「確定」照舊送出（取消那一句不會出現）', function () {
  const ui = makeUi();
  ui.click('resetWeekBtn');
  ui.click('confirmOkBtn');
  assert.strictEqual(ui.count('apiResetWeek'), 1);
  assert.strictEqual(ui.message(), null);
});

// =====================================================================
// G20：季度填寫表「處理填寫表衝突」對話框（src/ui/FillConflict.html）
// =====================================================================

console.log('\n處理填寫表衝突對話框沒有回應（G20）');

/**
 * 把 FillConflict.html 的 <script> 抽出來，三個樣板輸出標籤換成伺服器會給的值，在假 DOM
 * 上真的執行。按鈕的 onclick 寫在 HTML 屬性上，測試直接叫同一個函式（setAll、submitDecisions）。
 */
function makeFillConflictUi(seconds) {
  const html = readSrc('src/ui/FillConflict.html');
  const start = html.indexOf('<script>') + '<script>'.length;
  const code = html.slice(start, html.indexOf('</script>', start))
    .replace('<' + '?!= JSON.stringify(quarterId) ?' + '>', JSON.stringify('2027T4'))
    .replace('<' + '?!= conflictsJson ?' + '>', JSON.stringify([
      { isoDate: '2027-10-03', fieldKey: 'PAGE_TITLE', label: '序樂', snapshotValue: '舊', gridValue: '格子表', systemValue: '系統' }
    ]))
    .replace('<' + '?!= JSON.stringify(callTimeoutSec) ?' + '>', JSON.stringify(seconds || 120));
  assert.strictEqual(code.indexOf('<' + '?'), -1, '樣板標籤要全部換走');
  const dom = makeFakeDom();
  const timers = makeFakeTimers();
  const calls = [];
  const google = makeFakeGoogle(calls);
  let closed = 0;
  google.host = { close: function () { closed++; } };
  // 每一行三個 radio（render() 用 innerHTML 畫，假 DOM 不會解析，這裏按名稱給固定的假元素）。
  const radiosByName = {};
  dom.document.getElementsByName = function (name) {
    if (!radiosByName[name]) {
      radiosByName[name] = ['GRID', 'SYSTEM', 'SKIP'].map(function (v) { return { value: v, checked: false, disabled: false }; });
    }
    return radiosByName[name];
  };
  const ctx = { console: console, document: dom.document, google: google, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return {
    ctx: ctx, els: dom.elements, timers: timers, calls: calls, closed: function () { return closed; },
    radios: function (i) { return dom.document.getElementsByName('c' + i); },
    sent: function () { return calls.filter(function (x) { return x.name === 'apiResolveFillConflicts'; }).length; },
    submitAll: function (choice) {
      ctx.setAll(choice);
      ctx.submitDecisions();
      const c = calls.filter(function (x) { return x.name === 'apiResolveFillConflicts' && !x.taken; })[0];
      assert.ok(c, '沒有送出 apiResolveFillConflicts');
      c.taken = true;
      return c;
    }
  };
}

const FC_MENU = '「週報系統 ▸ 季度填寫表 ▸ 處理填寫表衝突」';
const FC_CONNECTION_MESSAGE = '伺服器沒有回應（apiResolveFillConflicts），這個動作可能已經完成。請按「取消」關閉這個視窗，再按選單'
  + FC_MENU + '核對：已經套用的格不會再列出（選了「暫不處理」的格仍會列出）。如果仍然列出，伺服器可能仍在處理，'
  + '請等 5 分鐘再開一次核對，不要即時再選一次。';
function fcTimeoutMessage(seconds) {
  return '伺服器在 ' + seconds + ' 秒內沒有回應（apiResolveFillConflicts），伺服器可能仍在處理（最長約 6 分鐘）。'
    + '請按「取消」關閉這個視窗，等 6 分鐘後再按選單' + FC_MENU + '核對，不要即時再選一次；亦可請 IT 看 Apps Script 的「執行項目」。';
}

test('G20-1 對話框按「確定」→ apiResolveFillConflicts 收到 HTTP 502 → 講「可能已經完成」與怎樣核對；「確定」維持停用、只可以按「取消」；沒有自動重試', function () {
  const ui = makeFillConflictUi();
  const call = ui.submitAll('GRID');
  assert.strictEqual(ui.els.confirmBtn.disabled, true, '送出時停用');
  call.fail(new Error(NETWORK_502));
  assert.strictEqual(ui.els.status.textContent, FC_CONNECTION_MESSAGE);
  assert.strictEqual(ui.els.confirmBtn.disabled, true, '不可以即時再送一次');
  assert.strictEqual(ui.els.cancelBtn.disabled, false, '可以按「取消」關閉');
  assert.strictEqual(ui.calls.filter(function (c) { return c.name === 'apiResolveFillConflicts'; }).length, 1, '沒有自動重試');
  assert.strictEqual(ui.closed(), 0, '不自動關閉，讓人看到訊息');
  assertWrittenChinese(assert, 'G20 對話框訊息', [FC_CONNECTION_MESSAGE, fcTimeoutMessage(120)]);
});

test('G20-2 對話框自己的逾時（Config 的秒數）→ 逾時那一句（伺服器可能仍在處理、等 6 分鐘、執行項目）；逾時之後才回來的回應不理會', function () {
  const ui = makeFillConflictUi(90);
  const call = ui.submitAll('SYSTEM');
  assert.strictEqual(ui.timers.run(90000), 1, '逾時計時器跟 Config 的秒數');
  assert.strictEqual(ui.els.status.textContent, fcTimeoutMessage(90));
  assert.strictEqual(ui.els.confirmBtn.disabled, true);
  assert.strictEqual(ui.els.cancelBtn.disabled, false);
  call.ok({ ok: true, data: { message: '已套用：填寫表 0 格、系統 1 格；暫不處理 0 格（下次同步仍然會問）。' } });
  assert.strictEqual(ui.els.status.textContent, fcTimeoutMessage(90), '逾時之後才回來的回應被擋掉');
});

test('G20-3 伺服器明確的失敗照舊：ok:false →「失敗：…」可以再按；伺服器拋出的例外 →「呼叫伺服器失敗（…）：…」可以再按', function () {
  const ui = makeFillConflictUi();
  ui.submitAll('GRID').ok({ ok: false, error: { message: '送來 1 個選擇，但在季度 2027T4 找不到對應的衝突，請重新開啟對話框再試。' } });
  assert.strictEqual(ui.els.status.textContent, '失敗：送來 1 個選擇，但在季度 2027T4 找不到對應的衝突，請重新開啟對話框再試。');
  assert.strictEqual(ui.els.confirmBtn.disabled, false);

  const ui2 = makeFillConflictUi();
  ui2.submitAll('GRID').fail(new Error('Exception: 你沒有權限編輯這個試算表。'));
  assert.strictEqual(ui2.els.status.textContent, '呼叫伺服器失敗（apiResolveFillConflicts）：Exception: 你沒有權限編輯這個試算表。');
  assert.strictEqual(ui2.els.confirmBtn.disabled, false);
});

test('G20b-1 「確定」→ 502（確定停用）→ 按「全部用系統」或改單一行 →「確定」不會重新啟用、選擇不變；再叫 submitDecisions() 亦不會再送', function () {
  const ui = makeFillConflictUi();
  ui.submitAll('GRID').fail(new Error(NETWORK_502));
  assert.strictEqual(ui.els.confirmBtn.disabled, true, '前提');
  ui.ctx.setAll('SYSTEM');
  ui.ctx.onChoiceChange(0, 'SKIP');
  assert.strictEqual(ui.els.confirmBtn.disabled, true, '「確定」不可以重新啟用');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ui.ctx.decisions)), ['GRID'], '選擇不變');
  assert.strictEqual(ui.els.setAllSystemBtn.disabled, true, '「全部用…」停用');
  assert.ok(ui.radios(0).every(function (r) { return r.disabled === true; }), '選項停用');
  ui.ctx.submitDecisions();
  assert.strictEqual(ui.sent(), 1, '沒有再送');
  assert.strictEqual(ui.els.status.textContent, FC_CONNECTION_MESSAGE, '訊息保留');
});

test('G20b-2 「處理中…」期間（未有回應）按「全部用…」或改選擇 →「確定」不會重新啟用、不會再送', function () {
  const ui = makeFillConflictUi();
  const call = ui.submitAll('GRID');
  ui.ctx.setAll('SKIP');
  assert.strictEqual(ui.els.confirmBtn.disabled, true);
  ui.ctx.submitDecisions();
  assert.strictEqual(ui.sent(), 1);
  assert.strictEqual(call.args[1][0].choice, 'GRID', '送出的是按「確定」那一刻的選擇');
});

test('G20b-3 伺服器明確回失敗（ok:false）→ 解除：選項與「全部用…」恢復，可以改選擇再送；伺服器回成功 →「關閉」可按，選項仍然停用', function () {
  const ui = makeFillConflictUi();
  ui.submitAll('GRID').ok({ ok: false, error: { message: '送來 1 個選擇，但在季度 2027T4 找不到對應的衝突，請重新開啟對話框再試。' } });
  assert.strictEqual(ui.els.setAllGridBtn.disabled, false);
  assert.ok(ui.radios(0).every(function (r) { return r.disabled === false; }));
  assert.strictEqual(ui.els.confirmBtn.disabled, false);
  ui.submitAll('SYSTEM').ok({ ok: true, data: { message: '已套用：填寫表 0 格、系統 1 格；暫不處理 0 格（下次同步仍然會問）。' } });
  assert.strictEqual(ui.sent(), 2);
  assert.strictEqual(ui.els.confirmBtn.textContent, '關閉');
  assert.strictEqual(ui.els.confirmBtn.disabled, false);
  ui.ctx.setAll('GRID');
  assert.strictEqual(ui.els.setAllGridBtn.disabled, true, '完成之後不可以再改');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ui.ctx.decisions)), ['SYSTEM']);
});

test('G20-4 判斷「沒有回應」的一段：Script.html 與 FillConflict.html 一字不差（照搬，兩處註明要同步）', function () {
  function sharedBody(rel) {
    const text = readSrc(rel);
    const begin = text.indexOf('// BEGIN no-response-detect');
    const end = text.indexOf('// END no-response-detect');
    assert.ok(begin !== -1 && end > begin, rel + ' 找不到 no-response-detect 區段');
    assert.ok(text.slice(begin, text.indexOf('\n', begin)).indexOf('同步') !== -1, rel + ' 的標記要註明同步');
    return text.slice(text.indexOf('\n', begin) + 1, end);
  }
  assert.strictEqual(sharedBody('src/ui/FillConflict.html'), sharedBody('src/ui/Script.html'));
});

// =====================================================================
// G18／G22(a)：發佈沒有回應，提示按這一次做甚麼寫核對的地方
// =====================================================================

console.log('\n發佈沒有回應的提示（G18／G22(a)）');

test('G18-1 只發佈 → 502 → 叫人看頁頂「目前已發佈」，不再叫人看「最後儲存時間」（發佈不會改它）', function () {
  const ui = makeUi();
  publishWith502(ui, true, false);
  assert.deepStrictEqual(ui.message(), { type: 'error', text: EXPECTED_PUBLISH_ONLY_MESSAGE });
  assert.strictEqual(ui.els.publishResult.textContent, EXPECTED_PUBLISH_ONLY_MESSAGE);
  assert.strictEqual(ui.log.publishPanel, 1, '頁頂「目前已發佈」要重新載入（句子講了已重新載入）');
  assert.ok(EXPECTED_PUBLISH_ONLY_MESSAGE.indexOf('最後儲存時間') === -1);
});

test('G18-2 只寄出 → 502 → 叫人看 SendLog、不要即時再按；發佈加寄出 → 兩樣都講，並提示已發佈而未寄出的話只勾「寄出」', function () {
  const send = makeUi();
  publishWith502(send, false, true);
  assert.deepStrictEqual(send.message(), { type: 'error', text: EXPECTED_SEND_ONLY_MESSAGE });

  const both = makeUi();
  publishWith502(both, true, true);
  assert.deepStrictEqual(both.message(), { type: 'error', text: EXPECTED_PUBLISH_AND_SEND_MESSAGE });
  assert.strictEqual(both.els.publishConfirmError.textContent, EXPECTED_PUBLISH_AND_SEND_MESSAGE, '發佈前檢查視窗內也要有');
  assertWrittenChinese(assert, 'G18 發佈提示', [EXPECTED_SEND_ONLY_MESSAGE, EXPECTED_PUBLISH_ONLY_MESSAGE, EXPECTED_PUBLISH_AND_SEND_MESSAGE]);
});

test('G18-3 describeNoResponseFailure()：不知道這一次做甚麼（沒有 payload）時用發佈加寄出那一句；其他種類不看 payload', function () {
  const ui = makeUi();
  assert.strictEqual(ui.ctx.describeNoResponseFailure('apiRunPublish', 'publish', []), EXPECTED_PUBLISH_AND_SEND_MESSAGE);
  assert.strictEqual(ui.ctx.describeNoResponseFailure('apiRunPublish', 'publish'), EXPECTED_PUBLISH_AND_SEND_MESSAGE);
  assert.strictEqual(ui.ctx.describeNoResponseFailure('apiResetWeek', 'week', [{ doPublish: true }]), expectedWeekMessage('apiResetWeek'));
});

// =====================================================================
// G25：等候期間發佈前檢查視窗（以及其他在 #mainContent 以外的對話框）不可以再送
// =====================================================================

console.log('\n等候期間對話框不可以再送（G25）');

/** 按「執行」→ 伺服器要求確認 → 視窗打開 → 勾選 → 按「確認發佈」，回傳那一個請求。 */
function publishThroughConfirm(ui) {
  Object.assign(ui.ctx.state.publish, { pdfBase64: 'QUFB', pdfName: '週報.pdf', pdfIsoDate: D });
  ui.els.doPublishCheck.checked = true;
  ui.click('publishRunBtn');
  ui.take('apiRunPublish').ok({ ok: true, data: { ok: false, reason: 'NEEDS_CONFIRM', lines: ['未填欄位（3 項）'],
    labels: { title: '發佈前檢查', checkbox: '我明白以上情況，仍然要發佈', confirmButton: '確認發佈' } } });
  assert.strictEqual(ui.els.publishConfirmBackdrop.classList.contains('hidden'), false, '前提：發佈前檢查視窗打開了');
  ui.els.publishForcedCheck.checked = true;
  ui.els.publishForcedCheck.listeners.change({ target: ui.els.publishForcedCheck });
  assert.strictEqual(ui.els.publishConfirmOkBtn.disabled, false, '前提：勾了之後可以按');
  ui.click('publishConfirmOkBtn');
  const call = ui.take('apiRunPublish');
  assert.strictEqual(call.args[0].confirmed, true);
  return call;
}

test('G25-1 「確認發佈」之後 502，等候 20 秒期間：再勾一下勾選格不會重新啟用「確認發佈」；按「確認發佈」、「執行」或直接叫 runPublish() 都不會再送', function () {
  const ui = makeUi();
  publishThroughConfirm(ui).fail(new Error(NETWORK_502));
  assert.strictEqual(ui.ctx.state.inFlight, 1, '前提：等候期間介面忙碌');
  ui.els.publishForcedCheck.checked = false;
  ui.els.publishForcedCheck.listeners.change({ target: ui.els.publishForcedCheck });
  ui.els.publishForcedCheck.checked = true;
  ui.els.publishForcedCheck.listeners.change({ target: ui.els.publishForcedCheck });
  assert.strictEqual(ui.els.publishConfirmOkBtn.disabled, true, '勾選格不可以把按鈕重新啟用');
  ui.click('publishConfirmOkBtn');
  ui.click('publishRunBtn');
  ui.ctx.runPublish(true);
  assert.strictEqual(ui.count('apiRunPublish'), 2, '只有「執行」與第一次「確認發佈」兩個請求');
  ui.timers.run(ui.delayMs);
  assert.strictEqual(ui.ctx.state.inFlight, 0);
});

test('G25-2 「確認發佈」送出之後、伺服器未回應之前按視窗的「取消」→ 不關閉、不講「已取消，一格都沒有寫。」（可能已經發佈）；「取消」按鈕處理中停用', function () {
  const ui = makeUi();
  const call = publishThroughConfirm(ui);
  assert.strictEqual(ui.els.publishConfirmCancelBtn.disabled, true, '處理中「取消」停用');
  ui.click('publishConfirmCancelBtn');
  assert.strictEqual(ui.els.publishConfirmBackdrop.classList.contains('hidden'), false, '視窗不關閉');
  assert.notDeepStrictEqual(ui.message(), { type: 'info', text: CANCELLED });
  call.ok({ ok: true, data: { ok: true, lines: ['已發佈：第 4 版'], published: { versionNo: 4 } } });
  assert.strictEqual(ui.els.publishConfirmCancelBtn.disabled, false, '完成之後還原');
});

test('G25-3 其他在 #mainContent 以外的對話框：處理中「由職事表重新取數」兩粒按鈕停用、確定不送、取消不講「一格都沒有寫」；頁內確認對話框的確定與 Esc 處理中不算數', function () {
  const ui = makeUi({ extra: [['function confirmFetchFromRoster(', 'function schedulePreviewRefresh(']] });
  ui.ctx.beginRequest('處理中…');
  assert.strictEqual(ui.els.fetchConfirmBtn.disabled, true);
  assert.strictEqual(ui.els.fetchCancelBtn.disabled, true);
  ui.ctx.confirmFetchFromRoster();
  ui.ctx.cancelFetchFromRoster();
  assert.strictEqual(ui.count('apiFetchFromRoster'), 0);
  assert.strictEqual(ui.message(), null);

  let settled = null;
  ui.ctx.openConfirmDialog('測試', ['一行'], function (ok) { settled = ok; });
  ui.click('confirmOkBtn');
  ui.dom.docListeners.keydown({ key: 'Escape' });
  assert.strictEqual(settled, null, '處理中確定與 Esc 都不算數');
  ui.ctx.endRequest();
  ui.click('confirmOkBtn');
  assert.strictEqual(settled, true, '處理完之後照常');
  assert.strictEqual(ui.els.fetchConfirmBtn.disabled, false);
});

// =====================================================================
// G26：HTTP 401／403 不是「沒有回應」，是登入狀態有問題，請求沒有到伺服器
// =====================================================================

console.log('\nHTTP 401／403（G26）');

function signInMessage(status) {
  return 'Google 登入狀態有問題（HTTP ' + status + '），這個動作沒有送到伺服器。請重新載入頁面；如果用了多個 Google 帳戶，請只登入教會帳戶再試。';
}

test('G26-1 「重設這一週」按確定 → NetworkError … HTTP 403 → 即時講登入狀態有問題（不講「可能已經完成」），不等候、不重新載入；ErrorLog 記原本的錯誤，不加「連線錯誤」註記', function () {
  const ui = makeUi();
  ui.click('resetWeekBtn');
  ui.click('confirmOkBtn');
  ui.take('apiResetWeek').fail(new Error('NetworkError: Connection failure due to HTTP 403'));
  assert.deepStrictEqual(ui.message(), { type: 'error', text: signInMessage(403) });
  assert.strictEqual(ui.timers.pending(ui.delayMs), 0, '不等候');
  assert.strictEqual(ui.count('apiLoadWeek'), 0);
  assert.strictEqual(ui.ctx.state.inFlight, 0);
  const report = ui.take('apiLogClientError').args[0];
  assert.strictEqual(report.message, '呼叫伺服器失敗（apiResetWeek）：NetworkError: Connection failure due to HTTP 403');
  assertWrittenChinese(assert, 'G26 登入', [signInMessage(403)]);
});

test('G26-2 儲存 → HTTP 401 → 登入那一句，表單上的改動保留、「儲存」可以再按；讀取類（看差異）→ HTTP 401 → 同一句', function () {
  const save = makeUi();
  save.ctx.form.PAGE_TITLE = '新序樂';
  save.click('saveBtn');
  save.take('apiSaveWeek').fail(new Error('NetworkError: Connection failure due to HTTP 401'));
  assert.deepStrictEqual(save.message(), { type: 'error', text: signInMessage(401) });
  assert.strictEqual(save.ctx.form.PAGE_TITLE, '新序樂');
  assert.strictEqual(save.els.saveBtn.disabled, false);
  assert.strictEqual(save.els.saveBtn.textContent, '儲存');

  const read = makeUi();
  clickRestoreButton(read, 'SNAP-1');
  read.take('apiDiffWeekSnapshot').fail(new Error('NetworkError: Connection failure due to HTTP 401'));
  assert.deepStrictEqual(read.message(), { type: 'error', text: signInMessage(401) });
});

test('G26-3 分類：HTTP 0、5xx、沒有狀態碼的 NetworkError 才算沒有回應；401／403 是登入；404、429 照舊當失敗', function () {
  const ui = makeUi();
  const c = ui.ctx;
  const e = function (m) { return new Error(m); };
  [['NetworkError: Connection failure due to HTTP 0', true], ['NetworkError: Connection failure due to HTTP 502', true],
    ['Connection failure due to HTTP 503', true], ['NetworkError', true], ['TypeError: Failed to fetch', true],
    ['NetworkError: Connection failure due to HTTP 404', false], ['NetworkError: Connection failure due to HTTP 429', false],
    ['NetworkError: Connection failure due to HTTP 401', false], ['NetworkError: Connection failure due to HTTP 403', false]
  ].forEach(function (pair) {
    assert.strictEqual(c.isNoResponseFailure(e(pair[0])), pair[1], pair[0]);
  });
  assert.strictEqual(c.isSignInFailure(e('NetworkError: Connection failure due to HTTP 401')), true);
  assert.strictEqual(c.isSignInFailure(e('NetworkError: Connection failure due to HTTP 403')), true);
  assert.strictEqual(c.isSignInFailure(e('NetworkError: Connection failure due to HTTP 502')), false);
  const timeoutErr = e('伺服器在 120 秒內沒有回應。');
  timeoutErr.noResponse = true;
  assert.strictEqual(c.isSignInFailure(timeoutErr), false);
  assert.strictEqual(c.isNoResponseFailure(timeoutErr), true);

  // HTTP 404：寫入類照舊當失敗（「呼叫伺服器失敗（…）」），不講「可能已經完成」。
  const w = makeUi();
  w.click('resetWeekBtn');
  w.click('confirmOkBtn');
  w.take('apiResetWeek').fail(e('NetworkError: Connection failure due to HTTP 404'));
  assert.deepStrictEqual(w.message(), { type: 'error', text: '呼叫伺服器失敗（apiResetWeek）：NetworkError: Connection failure due to HTTP 404' });
  assert.strictEqual(w.timers.pending(w.delayMs), 0);
});

test('G26-4 「處理填寫表衝突」對話框 → HTTP 403 → 登入那一句，「確定」可以再按（請求沒有到伺服器）', function () {
  const ui = makeFillConflictUi();
  ui.submitAll('GRID').fail(new Error('NetworkError: Connection failure due to HTTP 403'));
  assert.strictEqual(ui.els.status.textContent, signInMessage(403));
  assert.strictEqual(ui.els.confirmBtn.disabled, false);
});

// =====================================================================
// G27：沒有回應之後自動重新載入亦失敗，不可以蓋走「可能已經完成」那一句
// =====================================================================

console.log('\n重新載入亦失敗（G27）');

const RELOAD_FAILED = '重新載入亦失敗，請稍後按 F5 重新整理。';

test('G27-1 還原 → 502 → 20 秒後重新載入（apiLoadWeek）亦 502 → 頁頂仍是原本那一句，後面加「重新載入亦失敗，請稍後按 F5 重新整理。」；伺服器回 ok:false 亦一樣', function () {
  [function (call) { call.fail(new Error(NETWORK_502)); },
    function (call) { call.ok({ ok: false, error: { message: '工作表結構落後於程式碼' } }); }].forEach(function (failReload, i) {
    const ui = makeUi();
    clickRestoreButton(ui, 'SNAP-1');
    ui.take('apiDiffWeekSnapshot').ok(DIFF_OK);
    ui.click('confirmOkBtn');
    ui.take('apiRestoreWeekSnapshot').fail(new Error(NETWORK_502));
    ui.timers.run(ui.delayMs);
    failReload(ui.take('apiLoadWeek'));
    assert.deepStrictEqual(ui.message(), { type: 'error', text: expectedWeekMessage('apiRestoreWeekSnapshot') + RELOAD_FAILED }, '第 ' + i + ' 種');
  });
  assertWrittenChinese(assert, 'G27', [RELOAD_FAILED]);
});

// v3：G27-2（季度作業沒有回應之後重新載入季度作業亦失敗）隨季度作業區塊拿走；「更新本季內容表…」重新載入的是
//    主日，與 G27-1 同一條路。

test('G27-3 平常的載入失敗照舊（不是沒有回應之後的重新載入）：「呼叫伺服器失敗（apiLoadWeek）：…」', function () {
  const ui = makeUi();
  ui.ctx.loadWeek(D);
  ui.take('apiLoadWeek').fail(new Error('Exception: 找不到這個主日。'));
  assert.deepStrictEqual(ui.message(), { type: 'error', text: '呼叫伺服器失敗（apiLoadWeek）：Exception: 找不到這個主日。' });
});

// =====================================================================
// G19 補充：發佈前檢查視窗按過「確認發佈」之後，「取消」不可以講「已取消，一格都沒有寫。」
// =====================================================================

console.log('\n發佈前檢查視窗送出之後按「取消」（G19 補充）');

test('G19b-1 「確認發佈」→ 502 → 20 秒之後視窗內與頁頂出「可能已經完成」→ 按「取消」（唯一關閉方法）→ 視窗關閉，頁頂仍是那一句', function () {
  const ui = makeUi();
  publishThroughConfirm(ui).fail(new Error(NETWORK_502));
  ui.timers.run(ui.delayMs);
  assert.deepStrictEqual(ui.message(), { type: 'error', text: EXPECTED_PUBLISH_ONLY_MESSAGE }, '前提');
  assert.strictEqual(ui.els.publishConfirmBackdrop.classList.contains('hidden'), false, '前提：視窗仍然開着');
  ui.click('publishConfirmCancelBtn');
  assert.strictEqual(ui.els.publishConfirmBackdrop.classList.contains('hidden'), true, '視窗關閉');
  assert.deepStrictEqual(ui.message(), { type: 'error', text: EXPECTED_PUBLISH_ONLY_MESSAGE }, '不可以換成「已取消」');
});

test('G19b-2 「確認發佈」→ 伺服器回 ok:false → 按「取消」→ 頁頂仍是伺服器那一句；未送出就取消照舊講「已取消，一格都沒有寫。」；再次打開視窗重新計算', function () {
  const ui = makeUi();
  const busyText = '另一個發佈或匯入正在執行中，20 秒內都拿不到指令碼鎖，因此這一次沒有做任何事。';
  publishThroughConfirm(ui).ok({ ok: true, data: { ok: false, reason: 'LOCK_BUSY', message: busyText } });
  ui.click('publishConfirmCancelBtn');
  assert.deepStrictEqual(ui.message(), { type: 'error', text: busyText });

  // 同一頁再按「執行」→ 伺服器要求確認 → 視窗重新打開（未送出）→ 取消 → 照舊那一句。
  ui.click('publishRunBtn');
  ui.take('apiRunPublish').ok({ ok: true, data: { ok: false, reason: 'NEEDS_CONFIRM', lines: ['未填欄位（3 項）'],
    labels: { title: '發佈前檢查', checkbox: '我明白以上情況，仍然要發佈', confirmButton: '確認發佈' } } });
  ui.click('publishConfirmCancelBtn');
  assert.deepStrictEqual(ui.message(), { type: 'info', text: CANCELLED });
});

test('G19b-3 其他確認對話框沒有同類路徑：openConfirmDialog() 的「確定」先關閉對話框才送出；由職事表重新取數亦先關閉才送出', function () {
  const js = readSrc('src/ui/Script.html');
  const settle = between(js, 'function settleConfirmDialog(', 'function onConfirmDialogKeydown(');
  assert.ok(settle.indexOf("classList.add('hidden')") < settle.indexOf('callback(accepted === true)'), '先關閉才交回呼叫方');
  const fetch = between(js, 'function confirmFetchFromRoster(', 'function schedulePreviewRefresh(');
  assert.ok(fetch.indexOf('closeFetchDialog();') !== -1 && fetch.indexOf('closeFetchDialog();') < fetch.indexOf("callServer('apiFetchFromRoster'"));
});

// =====================================================================
// G24：寫入類沒有回應的結尾，按連線錯誤與逾時分
// =====================================================================

console.log('\n寫入類沒有回應的結尾（G24）');

test('G24-1 連線錯誤：每一個寫入種類（儲存除外）的句子都以「如果仍未看到結果……不要即時再做一次。」作結（只寄出改講再寄），不再有「確認未完成才再做一次」', function () {
  const ui = makeUi();
  ['week', 'publish', 'quarterOps', 'quarterImport'].forEach(function (kind) {
    const text = ui.ctx.describeNoResponseFailure('apiX', kind, []);
    assert.ok(text.indexOf('確認未完成才再做一次') === -1, kind + '：' + text);
    assert.ok(text.indexOf(WAIT_ENDING) !== -1, kind + '：' + text);
  });
  assert.strictEqual(EXPECTED_SEND_ONLY_MESSAGE.indexOf('確認未'), -1);
  const codeLines = readSrc('src/ui/Script.html').split('\n').filter(function (line) {
    const t = line.trim();
    return !(t.indexOf('*') === 0 || t.indexOf('//') === 0);
  });
  assert.strictEqual(codeLines.join('\n').indexOf('確認未完成才再做一次'), -1, 'Script.html 的程式碼內不再有這一句（註解講歷史除外）');
  assertWrittenChinese(assert, 'G24 連線錯誤結尾', [WAIT_ENDING, EXPECTED_SEND_ONLY_MESSAGE, EXPECTED_PUBLISH_AND_SEND_MESSAGE]);
});

test('G24-2 逾時（120 秒）：更新本季內容表、只寄出、發佈加寄出都講「伺服器可能仍在處理（最長約 6 分鐘）……請等 6 分鐘後重新載入頁面……執行項目」；秒數跟 Config', function () {
  // 內容表 v2：「建立講員表格」那一段隨講員表格停用拿走。v3：季度作業拿走，改用「更新本季內容表…」。
  const ops = makeUi({ extra: [['function startContentSheetUpgrade(', 'function onContentImportDone(']] });
  ops.ctx.startContentSheetUpgrade();
  ops.take('apiPreviewContentSheetBuild').ok({ ok: true, data: { ok: true, lines: ['會加上新的欄。'] } });
  ops.click('confirmOkBtn');
  ops.take('apiRunContentSheetBuild');
  ops.timers.run(120000);
  ops.timers.run(ops.delayMs);
  assert.deepStrictEqual(ops.message(), { type: 'error', text: expectedTimeoutMessage('apiRunContentSheetBuild', '「最後儲存時間」和「版本記錄」') });

  const send = makeUi();
  send.els.doSendCheck.checked = true;
  send.click('publishRunBtn');
  send.take('apiRunPublish');
  send.timers.run(120000);
  send.timers.run(send.delayMs);
  assert.deepStrictEqual(send.message(), { type: 'error', text: expectedTimeoutMessage('apiRunPublish', '試算表的 SendLog', '不要即時再寄，以免重複寄信') });

  const both = makeUi();
  assert.strictEqual(both.ctx.describeNoResponseFailure('apiRunPublish', 'publish', [{ doPublish: true, doSend: true }], true, 120),
    expectedTimeoutMessage('apiRunPublish', '頁頂「目前已發佈」和試算表的 SendLog', null, '已經發佈而未寄出的話，再做時只勾「寄出」。'));
  assert.ok(both.ctx.describeNoResponseFailure('apiResetWeek', 'week', [], true, 90).indexOf('伺服器在 90 秒內沒有回應（apiResetWeek）') === 0);
  assertWrittenChinese(assert, 'G24 逾時', [expectedTimeoutMessage('apiRunContentSheetBuild', '「最後儲存時間」和「版本記錄」'), EXPECTED_SAVE_TIMEOUT_MESSAGE]);
});

test('G24-3 儲存：連線錯誤照舊即時再按（G23 之後第二次要等第一次寫完才讀，會回 STALE）；逾時講「伺服器可能仍在處理，請等一兩分鐘才再按「儲存」」', function () {
  const conn = makeUi();
  conn.click('saveBtn');
  conn.take('apiSaveWeek').fail(new Error(NETWORK_502));
  assert.deepStrictEqual(conn.message(), { type: 'error', text: EXPECTED_SAVE_MESSAGE });

  const slow = makeUi();
  slow.click('saveBtn');
  slow.timers.run(120000);
  assert.deepStrictEqual(slow.message(), { type: 'error', text: EXPECTED_SAVE_TIMEOUT_MESSAGE });
  assert.strictEqual(slow.timers.pending(slow.delayMs), 0, '儲存照舊不等候、不重新載入');
  assert.strictEqual(slow.els.saveBtn.disabled, false);
});

// =====================================================================
// G17：讀取類動作逾時，不可以講「動作可能已經做了」
// =====================================================================

console.log('\n讀取類動作逾時（G17）');

/** G17：讀取類逾時的一句（秒數由 serverCallTimeoutMs() 計出來）。 */
function expectedReadTimeout(fnName, seconds) {
  return '伺服器在 ' + (seconds || 120) + ' 秒內沒有回應（' + fnName + '）。這是讀取資料，沒有改動週報內容；請稍後重新載入頁面再試。';
}

const EXPECTED_DOWNLOAD_TIMEOUT = '伺服器在 120 秒內沒有回應（apiDownloadBulletinDocx），Word 檔沒有下載到；請稍後再按一次「下載 Word」。'
  + '伺服器可能已經更新了雲端硬碟上這一期的最新 Word，再按一次只會原地更新同一個檔案，不會多出一份。';

/** 斷言：apiLogClientError 收到的就是畫面上那一句（照舊記錄），不加「連線錯誤」那一句。 */
function assertReportedAsIs(ui, fnName, text) {
  const reports = ui.calls.filter(function (c) { return c.name === 'apiLogClientError'; });
  assert.strictEqual(reports.length, 1, '要回報一次 ErrorLog');
  assert.strictEqual(reports[0].args[0].functionName, fnName);
  assert.strictEqual(reports[0].args[0].message, text);
}

// 內容表 v2：G17-1 以前用「講員表格現況」做讀取類的例子；講員表格停用之後改用版本記錄（同樣在自己的區塊顯示失敗）。
test('G17-1 版本記錄（真正的 loadSnapshotPanel()，唯讀）120 秒沒有回應 → 區塊內寫「這是讀取資料，沒有改動週報內容」；不講「可能已經做了」；沒有排重新載入；ErrorLog 照舊記錄', function () {
  const ui = makeUi({ extra: [['function setSnapshotStatus(', 'function refreshSnapshotPanel(']] });
  ui.ctx.loadSnapshotPanel();
  ui.take('apiListWeekSnapshots');
  assert.strictEqual(ui.timers.run(120000), 1, '前提：逾時計時器是 120 秒');

  const expected = expectedReadTimeout('apiListWeekSnapshots');
  assert.strictEqual(ui.els.snapshotStatus.textContent, '版本記錄載入失敗：' + expected);
  assert.ok(ui.els.snapshotStatus.textContent.indexOf('可能已經') === -1);
  assert.strictEqual(ui.timers.pending(ui.delayMs), 0, '讀取類不可以排重新載入');
  assert.strictEqual(ui.count('apiLoadWeek'), 0);
  assert.strictEqual(ui.count('apiListWeekSnapshots'), 1, '不自動再載入版本記錄');
  assertReportedAsIs(ui, 'apiListWeekSnapshots', expected);
  assertWrittenChinese(assert, 'G17 讀取類逾時', [expected]);
});

test('G17-2 按「還原到這個版本」時看差異（apiDiffWeekSnapshot，唯讀）120 秒沒有回應 → 頁頂原樣顯示讀取那一句（不加「呼叫伺服器失敗」）；沒有送出還原、沒有排重新載入', function () {
  const ui = makeUi();
  clickRestoreButton(ui, 'SNAP-1');
  ui.take('apiDiffWeekSnapshot');
  ui.timers.run(120000);
  const expected = expectedReadTimeout('apiDiffWeekSnapshot');
  assert.deepStrictEqual(ui.message(), { type: 'error', text: expected });
  assert.strictEqual(ui.count('apiRestoreWeekSnapshot'), 0);
  assert.strictEqual(ui.timers.pending(ui.delayMs), 0);
  assert.strictEqual(ui.count('apiLoadWeek'), 0);
  assert.strictEqual(ui.ctx.state.inFlight, 0, '介面即時可以再用');
  assertReportedAsIs(ui, 'apiDiffWeekSnapshot', expected);
});

test('G17-3 按「下載 Word」（真正的 downloadWord()）120 秒沒有回應 → Word 那一句：沒有下載到、再按一次、雲端硬碟可能已經更新；沒有排重新載入', function () {
  const ui = makeUi({ extra: [['function downloadWord(', 'function triggerBinaryDownload(']] });
  ui.click('downloadWordBtn');
  ui.take('apiDownloadBulletinDocx');
  ui.timers.run(120000);
  assert.deepStrictEqual(ui.message(), { type: 'error', text: EXPECTED_DOWNLOAD_TIMEOUT });
  assert.strictEqual(ui.timers.pending(ui.delayMs), 0);
  assert.strictEqual(ui.count('apiLoadWeek'), 0);
  assertReportedAsIs(ui, 'apiDownloadBulletinDocx', EXPECTED_DOWNLOAD_TIMEOUT);
  assertWrittenChinese(assert, 'G17 下載逾時', [EXPECTED_DOWNLOAD_TIMEOUT]);
});

test('v3 第 16 項：有未儲存的修改按「下載 Word」→ 三選一：已儲存的版本（不帶草稿）、包括未儲存修改（帶草稿）、取消（甚麼都不送）；沒有未儲存的修改直接下載', function () {
  const extra = [['function downloadWord(', 'function triggerBinaryDownload(']];
  const asPlain = function (v) { return JSON.parse(JSON.stringify(v)); };

  const clean = makeUi({ extra: extra });
  clean.click('downloadWordBtn');
  assert.deepStrictEqual(asPlain(clean.take('apiDownloadBulletinDocx').args), [D], '沒有未儲存的修改：直接下載已儲存的版本');
  assert.strictEqual(clean.els.confirmDialogBackdrop.classList.contains('hidden'), true);

  const alt = makeUi({ extra: extra });
  alt.ctx.form.PAGE_TITLE = '未儲存的標題';
  alt.click('downloadWordBtn');
  assert.strictEqual(alt.els.confirmDialogBackdrop.classList.contains('hidden'), false, '先問要哪一個版本');
  assert.strictEqual(alt.els.confirmOkBtn.textContent, '已儲存的版本');
  assert.strictEqual(alt.els.confirmAltBtn.textContent, '包括未儲存修改的版本（草稿）');
  assert.strictEqual(alt.els.confirmAltBtn.classList.contains('hidden'), false);
  assert.strictEqual(alt.count('apiDownloadBulletinDocx'), 0, '揀之前不送');
  alt.click('confirmAltBtn');
  const draftCall = alt.take('apiDownloadBulletinDocx');
  assert.strictEqual(draftCall.args[0], D);
  assert.deepStrictEqual(asPlain(draftCall.args[1].draft.week), { PAGE_TITLE: '未儲存的標題' }, '草稿與「儲存」送同一份（buildSavePayload）');
  assert.strictEqual(alt.count('apiSaveWeek'), 0, '下載草稿不會儲存');

  const ok = makeUi({ extra: extra });
  ok.ctx.form.PAGE_TITLE = '未儲存的標題';
  ok.click('downloadWordBtn');
  ok.click('confirmOkBtn');
  assert.deepStrictEqual(asPlain(ok.take('apiDownloadBulletinDocx').args), [D]);

  const cancel = makeUi({ extra: extra });
  cancel.ctx.form.PAGE_TITLE = '未儲存的標題';
  cancel.click('downloadWordBtn');
  cancel.click('confirmCancelBtn');
  assert.strictEqual(cancel.count('apiDownloadBulletinDocx'), 0);
  assert.strictEqual(cancel.message(), null, '下載不是寫入，取消不講「一格都沒有寫」');
  // 之後的一般確認對話框：按鈕字眼還原、第三粒收起。
  cancel.click('resetWeekBtn');
  assert.strictEqual(cancel.els.confirmOkBtn.textContent, '確定');
  assert.strictEqual(cancel.els.confirmCancelBtn.textContent, '取消');
  assert.strictEqual(cancel.els.confirmAltBtn.classList.contains('hidden'), true);
});

test('G17-4 寫入類逾時不跟讀取類：「還原到這個版本」按確定之後 120 秒沒有回應 → 等候、重新載入、寫入類逾時那一句（G24）；ErrorLog 記原本「可能已經做了」那一句加逾時註記', function () {
  const ui = makeUi();
  clickRestoreButton(ui, 'SNAP-1');
  ui.take('apiDiffWeekSnapshot').ok(DIFF_OK);
  ui.click('confirmOkBtn');
  ui.take('apiRestoreWeekSnapshot');
  ui.timers.run(120000);
  assertReportedAsNoResponse(ui, 'apiRestoreWeekSnapshot', '這一次的動作可能已經做了、也可能沒有做', true);
  assert.strictEqual(ui.timers.run(ui.delayMs), 1, '寫入類照舊等候之後重新載入');
  assert.deepStrictEqual(ui.message(), { type: 'error', text: expectedTimeoutMessage('apiRestoreWeekSnapshot', '「最後儲存時間」和「版本記錄」') });
  assert.deepStrictEqual(ui.take('apiLoadWeek').args, [D]);
});

test('G17-5 分類：讀取類每一個都是 read、三個例外各有自己的一類、寫入類是 write；逾時秒數跟 Config（data-call-timeout-sec）走', function () {
  const ui = makeUi();
  const reads = [
    'apiListWeeks', 'apiLoadWeek', 'apiPreviewProgram', 'apiPreviewContentImport', 'apiListWeekSnapshots',
    'apiDiffWeekSnapshot', 'apiGetRosterFetchCandidates', 'apiGetPublishStatus',
    'apiGetQuarterOpsPanel', 'apiPreviewCreateWeeks', 'apiPreviewContentSheetBuild', 'apiPreviewContentSheetInvite',
    'apiPreviewQuarterContentImport', 'apiQuarterMissingReport', 'apiRosterDiffReport', 'apiGoLiveReport',
    'apiPublishRevisionsReport'
  ];
  reads.forEach(function (name) {
    assert.strictEqual(ui.ctx.serverCallKind(name), 'read', name);
    assert.strictEqual(ui.ctx.describeCallTimeout(name, 120).text, expectedReadTimeout(name), name);
  });
  assert.strictEqual(ui.ctx.serverCallKind('apiDownloadBulletinDocx'), 'download');
  assert.strictEqual(ui.ctx.serverCallKind('apiSavePublishPrefs'), 'quiet');
  assert.strictEqual(ui.ctx.serverCallKind('apiLogClientError'), 'quiet');
  Object.keys(JSON.parse(JSON.stringify(ui.ctx.WRITE_ACTION_RECOVERY))).forEach(function (name) {
    assert.strictEqual(ui.ctx.serverCallKind(name), 'write', name);
    assert.ok(ui.ctx.describeCallTimeout(name, 120).text.indexOf('可能已經做了') !== -1, name);
  });
  ['apiSavePublishPrefs', 'apiLogClientError'].forEach(function (name) {
    assert.strictEqual(ui.ctx.describeCallTimeout(name, 120).showAsIs, false, name + ' 照舊');
  });

  // 秒數由 serverCallTimeoutMs() 計出來，不是寫死 120。
  const ui90 = makeUi({ extra: [['function setSnapshotStatus(', 'function refreshSnapshotPanel(']] });
  ui90.dom.document.getElementById('app').setAttribute('data-call-timeout-sec', '90');
  ui90.ctx.loadSnapshotPanel();
  assert.strictEqual(ui90.timers.run(90000), 1, '逾時計時器跟 Config 改成 90 秒');
  assert.strictEqual(ui90.els.snapshotStatus.textContent, '版本記錄載入失敗：' + expectedReadTimeout('apiListWeekSnapshots', 90));
});

test('G17-7 G17 補充：apiRosterDiffReport 會順手寫系統記錄（ROSTER_FOLLOW），所以讀取類那一句講「沒有改動週報內容」，不講「沒有改動任何東西」；2026-10-27 起載入不再寫回推算的程序範本 ID', function () {
  const ui = makeUi();
  ['apiRosterDiffReport', 'apiLoadWeek', 'apiQuarterMissingReport'].forEach(function (name) {
    assert.strictEqual(ui.ctx.serverCallKind(name), 'read', name);
    const text = ui.ctx.describeCallTimeout(name, 120).text;
    assert.ok(text.indexOf('沒有改動週報內容') !== -1, text);
    assert.strictEqual(text.indexOf('任何東西'), -1, text);
  });
  const gs = readSrc('src/RosterDiff.gs');
  assert.ok(gs.indexOf("action: 'ROSTER_FOLLOW'") !== -1, '前提：差異報告會寫 AuditLog');
  assert.strictEqual(readSrc('src/BulletinModel.gs').indexOf('persistInferredTemplateId_('), -1,
    '程序範本留空＝自動跟每週標題：載入不再寫回推算結果（寫回就等於人手揀過）');
});

test('G17-6 讀取類遇到連線錯誤（HTTP 502）照舊即時顯示「呼叫伺服器失敗（…）」，不講「可能已經完成」、不排重新載入', function () {
  // 內容表 v2：以前用講員表格現況做例子，講員表格停用之後改用版本記錄。
  const ui = makeUi({ extra: [['function setSnapshotStatus(', 'function refreshSnapshotPanel(']] });
  ui.ctx.loadSnapshotPanel();
  ui.take('apiListWeekSnapshots').fail(new Error(NETWORK_502));
  assert.strictEqual(ui.els.snapshotStatus.textContent, '版本記錄載入失敗：呼叫伺服器失敗（apiListWeekSnapshots）：' + NETWORK_502);
  assert.strictEqual(ui.timers.pending(ui.delayMs), 0);
  assert.ok(ui.take('apiLogClientError').args[0].message.indexOf('可能已') === -1);
});


console.log('\n審查後修正 4（v3 改寫）：只寄出不再要求確認 master 那一期');

// v3（Ivan 測試結果 A 第 18 項）：「寄出」一律寄這個主日的預覽連結與本季內容表連結；master 連結現在就是這一期才附上，
//    不再要求先確認 master 那一期，所以亦不再送 confirmedMasterIssue（Script.html 與 src 都沒有這一套）。
test('RV4-5 只寄出：按「執行」→ 伺服器 NEEDS_CONFIRM（寄出前檢查）→ 勾選、按「確認」→ 請求帶 confirmed:true，不帶 confirmedMasterIssue', function () {
  const ui = makeUi();
  ui.els.doPublishCheck.checked = false;
  ui.els.doSendCheck.checked = true;
  ui.click('publishRunBtn');
  const first = ui.take('apiRunPublish');
  assert.strictEqual(first.args[0].confirmed, false);
  first.ok({ ok: true, data: { ok: false, reason: 'NEEDS_CONFIRM', lines: ['未填欄位（3 項）'],
    labels: { title: '寄出前檢查', checkbox: '我明白以上情況，仍然要寄出', confirmButton: '確認寄出' } } });
  ui.els.publishForcedCheck.checked = true;
  ui.els.publishForcedCheck.listeners.change({ target: ui.els.publishForcedCheck });
  ui.click('publishConfirmOkBtn');
  const confirmed = ui.take('apiRunPublish');
  assert.strictEqual(confirmed.args[0].confirmed, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(confirmed.args[0], 'confirmedMasterIssue'), false);
  assert.strictEqual(readSrc('src/ui/Script.html').indexOf('confirmedMasterIssue'), -1, '前端不再有這一套');
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
