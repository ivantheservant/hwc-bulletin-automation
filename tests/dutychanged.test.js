#!/usr/bin/env node
/**
 * tests/dutychanged.test.js
 *
 * D9（docs/待確認事項.md FF-17、FF-26）：填寫介面儲存時，事奉框（本週與下週）只送「載入之後改過的格」，
 * 以及幹事對衝突格按了「保留我的」的格；伺服器對沒有送來的格一律不動，只會自動停用職事表已經追上的覆寫。
 *
 * 以前前端每次儲存都送全部格，結果：
 *   (a) 只改序樂儲存，那一週的「衝突」靜靜消失（覆寫對照的職事表值被更新成現在的值）——FF-17；
 *   (b) 分頁開着期間職事表換了人，只改序樂儲存，會新增一筆覆寫把載入時的舊名字釘死——FF-26。
 *
 * 後端一律經真正入口 apiSaveWeek；前端把 Script.html 的真正程式碼抽出來在假 DOM 上執行，由載入（apiLoadWeek
 * 的真回應）、在事奉框打字或按「保留我的」／「還原」、按「儲存」（wireStaticEvents() 接上的真按鈕），到把
 * 前端送出的 payload 原樣交給後端，整條路走一次。
 *
 * 執行方式：node tests/dutychanged.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { assertWrittenChinese } = require('./helpers/writtenChinese');
const { makeFillEnv, QUARTER_ID } = require('./helpers/fillEnv');
const { changedDutyCells, SAVE_PAYLOAD_VERSION } = require('./helpers/savePayload');

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
    console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n    ') : err));
  }
}

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

const W_BEFORE = '2027-11-07';
const W = '2027-11-14';
const W_AFTER = '2027-11-21';
const DATES = [W_BEFORE, W, W_AFTER, '2027-11-28'];
/** 假職事表 RosterAssignments 的資料由第 3 行開始，一個主日一行（只有主席一個崗位）。 */
const ROSTER_ROW_OF = { '2027-11-07': 3, '2027-11-14': 4, '2027-11-21': 5, '2027-11-28': 6 };

// =====================================================================
// 後端環境
// =====================================================================

/** 四個主日，主席全部是陳大文；最後儲存時間是舊日子。 */
function makeEnv() {
  const env = makeFillEnv({
    withGrid: false,
    weekRows: DATES.map(function (iso, i) {
      return { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: i + 1, STATUS: 'DRAFT', LAST_SAVED_AT: '2026-10-01' };
    }),
    config: { PRELUDE_DEFAULT: '預設序樂' }
  });
  return env.sandbox;
}

let nextPersonNo = 9100;
/** 職事表那邊把某一個主日的主席改成另一個人（只改假職事表，src 一格都不寫職事表）。 */
function rosterChangesChair(sb, iso, name) {
  const personId = 'P' + (nextPersonNo++);
  const roster = sb.SpreadsheetApp.openById('FAKE_ROSTER_ID_FOR_FILL_TESTS');
  const sh = roster.getSheetByName('RosterAssignments');
  const keys = sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.getRange(ROSTER_ROW_OF[iso], keys.indexOf('PersonID') + 1).setValue(personId);
  sh.getRange(ROSTER_ROW_OF[iso], keys.indexOf('PersonNameSnapshot') + 1).setValue(name);
  const nm = roster.getSheetByName('NameMapping');
  const nk = nm.getRange(2, 1, 1, nm.getLastColumn()).getValues()[0];
  nm.getRange(nm.getLastRow() + 1, 1, 1, nk.length).setValues([nk.map(function (k) {
    return k === 'PersonID' ? personId : k === 'NameTC' ? name : k === 'Active' ? true : '';
  })]);
  sb.ROSTER_TABLES_CACHE_ = null;   // 下一次執行：職事表的記憶體快取不跨執行
}

function load(sb, iso) { return plain(sb.loadWeekForWebApp_(iso)); }

/**
 * 照新版前端那樣儲存：week 只放改了的欄位；事奉框只送與載入時不同的格（changedDutyCells()）。
 * opts.duty／opts.next 是「鍵 → 畫面上的名字（或 {name, keepOverride}）」。
 */
function save(sb, iso, opts) {
  const o = opts || {};
  const tab = o.tab || load(sb, iso);
  const patch = o.patch || {};
  const payload = {
    isoDate: iso, lastSavedAt: tab.lastSavedAt, payloadVersion: SAVE_PAYLOAD_VERSION, week: patch,
    baseWeek: plain(sb.baseWeekFor_(tab.week, patch)),
    dutyEdits: changedDutyCells(tab.readOnly.dutyBoxPage1, o.duty || {}),
    nextWeekDutyEdits: changedDutyCells(tab.readOnly.nextWeekDuty, o.next || {})
  };
  const resp = sb.apiSaveWeek(plain(payload));
  return { resp: resp, payload: payload };
}

function overrideRows(sb, iso) {
  return plain(sb.readSheet_('DutyOverride').filter(function (r) {
    return r.POST_ID === 'CHAIR' && sb.formatIsoDate_(sb.normalizeDate_(r.SERVICE_DATE)) === iso;
  }));
}
function activeChair(sb, iso) { return overrideRows(sb, iso).filter(function (r) { return r.ACTIVE === true; })[0] || null; }
function conflictCount(sb, iso) { return sb.buildBulletinModel_(iso).rosterDiff.conflictCount; }
function chairSlot(tab, box) {
  const rows = tab.readOnly[box] || [];
  for (let i = 0; i < rows.length; i++) {
    const s = (rows[i].slots || []).filter(function (x) { return x.postId === 'CHAIR'; })[0];
    if (s) return s;
  }
  return null;
}
function rewindLastSavedAt(sb, iso, value) {
  const rowNo = sb.readBulletinWeekRowWithRowNo_(iso).__rowNo;
  sb.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BulletinWeeks')
    .getRange(rowNo, sb.COLUMNS.BULLETIN_WEEKS.keys.indexOf('LAST_SAVED_AT') + 1).setValue(value);
}

/** W 的主席覆寫成「李小明」（職事表當時是陳大文），之後職事表把 W 的主席改成「張三」→ 衝突。 */
function makeConflictEnv() {
  const sb = makeEnv();
  const made = save(sb, W, { duty: { 'CHAIR#1': '李小明' } });
  assert.strictEqual(made.resp.ok, true, JSON.stringify(made.resp.error));
  rosterChangesChair(sb, W, '張三');
  rewindLastSavedAt(sb, W, '2026-10-02');
  assert.strictEqual(conflictCount(sb, W), 1, '前提：W 有一個衝突');
  return sb;
}

/** W 的「下週事奉」把 W+7 的主席覆寫成「下週李」，之後職事表把 W+7 的主席改成「下週張」→ W+7 衝突。 */
function makeNextConflictEnv() {
  const sb = makeEnv();
  const made = save(sb, W, { next: { 'CHAIR#1': '下週李' } });
  assert.strictEqual(made.resp.ok, true, JSON.stringify(made.resp.error));
  rosterChangesChair(sb, W_AFTER, '下週張');
  rewindLastSavedAt(sb, W, '2026-10-02');
  rewindLastSavedAt(sb, W_AFTER, '2026-10-02');
  assert.strictEqual(conflictCount(sb, W_AFTER), 1, '前提：W+7 有一個衝突');
  return sb;
}

// =====================================================================
// 後端：經真正入口 apiSaveWeek
// =====================================================================

console.log('\n後端（真正入口 apiSaveWeek）：本週事奉');

test('D9-1（FF-17）只改序樂 → 衝突保留：覆寫對照的職事表值不變、不新增覆寫；事奉格一格都沒有送', function () {
  const sb = makeConflictEnv();
  const before = overrideRows(sb, W);
  const r = save(sb, W, { patch: { PAGE_TITLE: '新序樂' } });
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.deepStrictEqual(r.payload.dutyEdits, [], '前提：前端不送沒有改的格');
  assert.strictEqual(r.resp.data.message.text, '已儲存，更新了 1 個欄位。');
  assert.strictEqual(conflictCount(sb, W), 1, '衝突仍然在');
  assert.deepStrictEqual(overrideRows(sb, W), before, '覆寫一格都沒有改');
  assert.strictEqual(activeChair(sb, W).ROSTER_VALUE_AT_OVERRIDE, '陳大文');
});

test('D9-2（FF-26）分頁開着期間職事表把主席由陳大文改成張三 → 只改序樂儲存 → 沒有新覆寫；重新載入顯示職事表的新名字', function () {
  const sb = makeEnv();
  const tab = load(sb, W);
  assert.strictEqual(chairSlot(tab, 'dutyBoxPage1').bulletinName, '陳大文', '前提：載入時是陳大文');
  rosterChangesChair(sb, W, '張三');
  const r = save(sb, W, { tab: tab, patch: { PAGE_TITLE: '新序樂' } });
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.deepStrictEqual(overrideRows(sb, W), [], '一筆覆寫都沒有新增');
  const again = load(sb, W);
  assert.strictEqual(chairSlot(again, 'dutyBoxPage1').bulletinName, '張三');
  assert.strictEqual(chairSlot(again, 'dutyBoxPage1').hasOverride, false);
});

test('D9-3 改了有衝突那一格 → 衝突解除：名字是新名字、對照的職事表值是現在的張三', function () {
  const sb = makeConflictEnv();
  const r = save(sb, W, { duty: { 'CHAIR#1': '王五' } });
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.deepStrictEqual(plain(r.payload.dutyEdits), [{ postId: 'CHAIR', slotIndex: 1, name: '王五', baseName: '李小明' }]);
  assert.strictEqual(conflictCount(sb, W), 0);
  assert.strictEqual(activeChair(sb, W).OVERRIDE_NAME, '王五');
  assert.strictEqual(activeChair(sb, W).ROSTER_VALUE_AT_OVERRIDE, '張三');
  assert.strictEqual(r.resp.data.message.text, '已儲存，更新了 1 個欄位。');
});

test('D9-4 按「保留我的」（keepOverride:true）→ 衝突解除而名字不變；只算更新了 1 筆覆寫記錄', function () {
  const sb = makeConflictEnv();
  const r = save(sb, W, { duty: { 'CHAIR#1': { name: '李小明', keepOverride: true } } });
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.deepStrictEqual(plain(r.payload.dutyEdits), [{ postId: 'CHAIR', slotIndex: 1, name: '李小明', baseName: '李小明', keepOverride: true }]);
  assert.strictEqual(conflictCount(sb, W), 0, '衝突解除');
  const row = activeChair(sb, W);
  assert.strictEqual(row.OVERRIDE_NAME, '李小明', '名字不變');
  assert.strictEqual(row.ROSTER_VALUE_AT_OVERRIDE, '張三', '對照的職事表值更新到現在');
  assert.strictEqual(overrideRows(sb, W).length, 1, '沒有多一行');
  assert.ok(r.resp.data.message.text.indexOf('已儲存。欄位內容沒有改變，只更新了 1 筆覆寫記錄') === 0, r.resp.data.message.text);
});

test('D9-5 keepOverride 只認布林 true：字串 "true" 不算（衝突仍在、一格都不寫）；名字前後空白去掉之後與載入時相同 → 當作沒有改；「保留我的」的名字有空白亦照樣去掉', function () {
  const sb = makeConflictEnv();
  const tab = load(sb, W);
  const before = overrideRows(sb, W);
  const resp = sb.apiSaveWeek(plain({ isoDate: W, lastSavedAt: tab.lastSavedAt, payloadVersion: SAVE_PAYLOAD_VERSION,
    week: {}, baseWeek: {}, dutyEdits: [
      { postId: 'CHAIR', slotIndex: 1, name: '李小明', baseName: '李小明', keepOverride: 'true' }
    ] }));
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  assert.ok(resp.data.message.text.indexOf('沒有偵測到任何改動') !== -1, resp.data.message.text);
  assert.strictEqual(conflictCount(sb, W), 1);
  assert.deepStrictEqual(overrideRows(sb, W), before);

  const spaced = sb.apiSaveWeek(plain({ isoDate: W, lastSavedAt: tab.lastSavedAt, payloadVersion: SAVE_PAYLOAD_VERSION,
    week: {}, baseWeek: {}, dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '  李小明 ', baseName: '李小明' }] }));
  assert.strictEqual(spaced.ok, true, JSON.stringify(spaced.error));
  assert.strictEqual(conflictCount(sb, W), 1, '只是多了空白，不是改名');
  assert.deepStrictEqual(overrideRows(sb, W), before);

  const kept = sb.apiSaveWeek(plain({ isoDate: W, lastSavedAt: tab.lastSavedAt, payloadVersion: SAVE_PAYLOAD_VERSION,
    week: {}, baseWeek: {}, dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: ' 李小明', baseName: '李小明', keepOverride: true }] }));
  assert.strictEqual(kept.ok, true, JSON.stringify(kept.error));
  assert.strictEqual(conflictCount(sb, W), 0);
  assert.strictEqual(activeChair(sb, W).OVERRIDE_NAME, '李小明');
});

test('D9-6 後端第二重防線：名字與 baseName 相同而不是「保留我的」的格（例如有問題的前端照送全部格）→ 略過，不會把載入時的舊名字釘成覆寫', function () {
  const sb = makeEnv();
  const tab = load(sb, W);
  rosterChangesChair(sb, W, '張三');
  const resp = sb.apiSaveWeek(plain({ isoDate: W, lastSavedAt: tab.lastSavedAt, payloadVersion: SAVE_PAYLOAD_VERSION,
    week: {}, baseWeek: {}, dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '陳大文', baseName: '陳大文' }] }));
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  assert.deepStrictEqual(overrideRows(sb, W), []);
});

test('D9-7 職事表追上了覆寫（W 的主席覆寫是李小明，職事表亦改成李小明）→ 任何一次儲存都自動停用：甚麼都沒有改、只改序樂都一樣；畫面名字不變，W-7 不會收到 STALE', function () {
  const sb = makeEnv();
  save(sb, W, { duty: { 'CHAIR#1': '李小明' } });
  rosterChangesChair(sb, W, '李小明');
  rewindLastSavedAt(sb, W, '2026-10-02');
  const tabBefore = load(sb, W_BEFORE);
  const r = save(sb, W, {});
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.deepStrictEqual(r.payload.dutyEdits, []);
  assert.strictEqual(activeChair(sb, W), null, '自動停用');
  assert.strictEqual(overrideRows(sb, W).length, 1, '不刪行');
  assert.ok(r.resp.data.message.text.indexOf('已儲存。欄位內容沒有改變，只更新了 1 筆覆寫記錄') === 0, r.resp.data.message.text);
  const audit = sb.readSheet_('AuditLog').filter(function (a) { return a.ACTION === 'DUTY_OVERRIDE_CLEAR'; });
  assert.strictEqual(audit.length, 1);
  assert.ok(audit[0].NOTES.indexOf('職事表現在亦是「李小明」，與人手覆寫相同，儲存時自動改回跟隨職事表') !== -1, audit[0].NOTES);
  assert.strictEqual(chairSlot(load(sb, W), 'dutyBoxPage1').bulletinName, '李小明', '畫面名字不變');
  const wBefore = save(sb, W_BEFORE, { tab: tabBefore, patch: { PAGE_TITLE: 'W-7 序樂' } });
  assert.strictEqual(wBefore.resp.ok, true, 'W-7 不應收到 STALE：' + JSON.stringify(wBefore.resp.error));
  assertWrittenChinese(assert, 'D9 自動停用備註', [audit[0].NOTES]);

  // 只改序樂亦一樣（另一個環境）。
  const sb2 = makeEnv();
  save(sb2, W, { duty: { 'CHAIR#1': '李小明' } });
  rosterChangesChair(sb2, W, '李小明');
  rewindLastSavedAt(sb2, W, '2026-10-02');
  const r2 = save(sb2, W, { patch: { PAGE_TITLE: '新序樂' } });
  assert.strictEqual(r2.resp.ok, true, JSON.stringify(r2.resp.error));
  assert.strictEqual(activeChair(sb2, W), null);
  assert.strictEqual(r2.resp.data.message.text.indexOf('已儲存，更新了 1 個欄位。'), 0, r2.resp.data.message.text);
});

test('D9-8 沒有衝突、沒有覆寫時行為不變：只改序樂不碰 DutyOverride；改主席 → 新增覆寫（對照值是現在的職事表）；改回職事表的名字 → 停用（不刪行）', function () {
  const sb = makeEnv();
  const r1 = save(sb, W, { patch: { PAGE_TITLE: '新序樂' } });
  assert.strictEqual(r1.resp.ok, true, JSON.stringify(r1.resp.error));
  assert.deepStrictEqual(overrideRows(sb, W), []);
  rewindLastSavedAt(sb, W, '2026-10-02');
  const r2 = save(sb, W, { duty: { 'CHAIR#1': '王五' } });
  assert.strictEqual(r2.resp.ok, true, JSON.stringify(r2.resp.error));
  assert.strictEqual(activeChair(sb, W).OVERRIDE_NAME, '王五');
  assert.strictEqual(activeChair(sb, W).ROSTER_VALUE_AT_OVERRIDE, '陳大文');
  rewindLastSavedAt(sb, W, '2026-10-03');
  const r3 = save(sb, W, { duty: { 'CHAIR#1': '陳大文' } });
  assert.strictEqual(r3.resp.ok, true, JSON.stringify(r3.resp.error));
  assert.strictEqual(activeChair(sb, W), null);
  assert.strictEqual(overrideRows(sb, W).length, 1);
  assert.strictEqual(r3.resp.data.message.text, '已儲存，更新了 1 個欄位。');
});

console.log('\n後端（真正入口 apiSaveWeek）：下週事奉（寫下一個主日）');

test('D9-9 下週事奉 W+7 有衝突，W 只改序樂 → W+7 的衝突保留、不新增覆寫', function () {
  const sb = makeNextConflictEnv();
  const before = overrideRows(sb, W_AFTER);
  const r = save(sb, W, { patch: { PAGE_TITLE: '新序樂' } });
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.deepStrictEqual(r.payload.nextWeekDutyEdits, []);
  assert.strictEqual(conflictCount(sb, W_AFTER), 1);
  assert.deepStrictEqual(overrideRows(sb, W_AFTER), before);
});

test('D9-10 W 的分頁開着期間職事表把 W+7 的主席改了 → W 只改序樂儲存 → W+7 沒有新覆寫；重新載入 W，下週事奉顯示職事表的新名字', function () {
  const sb = makeEnv();
  const tab = load(sb, W);
  assert.strictEqual(chairSlot(tab, 'nextWeekDuty').bulletinName, '陳大文');
  rosterChangesChair(sb, W_AFTER, '下週張');
  const r = save(sb, W, { tab: tab, patch: { PAGE_TITLE: '新序樂' } });
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.deepStrictEqual(overrideRows(sb, W_AFTER), []);
  assert.strictEqual(chairSlot(load(sb, W), 'nextWeekDuty').bulletinName, '下週張');
});

test('D9-11 下週事奉：按「保留我的」→ 衝突解除而名字不變；改了有衝突那一格 → 衝突解除（寫的都是 W+7 那一筆）', function () {
  const sb = makeNextConflictEnv();
  const kept = save(sb, W, { next: { 'CHAIR#1': { name: '下週李', keepOverride: true } } });
  assert.strictEqual(kept.resp.ok, true, JSON.stringify(kept.resp.error));
  assert.strictEqual(conflictCount(sb, W_AFTER), 0);
  assert.strictEqual(activeChair(sb, W_AFTER).OVERRIDE_NAME, '下週李');
  assert.strictEqual(activeChair(sb, W_AFTER).ROSTER_VALUE_AT_OVERRIDE, '下週張');
  assert.deepStrictEqual(overrideRows(sb, W), [], 'W 自己一筆都沒有');

  const sb2 = makeNextConflictEnv();
  const edited = save(sb2, W, { next: { 'CHAIR#1': '下週王' } });
  assert.strictEqual(edited.resp.ok, true, JSON.stringify(edited.resp.error));
  assert.strictEqual(conflictCount(sb2, W_AFTER), 0);
  assert.strictEqual(activeChair(sb2, W_AFTER).OVERRIDE_NAME, '下週王');
});

test('D9-12 下週事奉：職事表把 W+7 的主席亦改成覆寫的名字 → W 任何一次儲存都自動停用 W+7 那一筆', function () {
  const sb = makeEnv();
  save(sb, W, { next: { 'CHAIR#1': '下週李' } });
  rosterChangesChair(sb, W_AFTER, '下週李');
  rewindLastSavedAt(sb, W, '2026-10-02');
  const r = save(sb, W, { patch: { PAGE_TITLE: '新序樂' } });
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.strictEqual(activeChair(sb, W_AFTER), null);
  assert.strictEqual(overrideRows(sb, W_AFTER).length, 1, '不刪行');
});

console.log('\n舊分頁（D9 之前的前端）');

test('D9-13 舊版前端（沒有 payloadVersion，照送全部事奉格）→ CLIENT_OUTDATED「介面版本已更新，請重新載入這一頁再儲存。」，一格都沒有寫；版本號是 1 或字串 "2" 亦一樣；不寫 ErrorLog', function () {
  const sb = makeConflictEnv();
  const tab = load(sb, W);
  const snapshot = function () { return JSON.stringify([sb.readSheet_('BulletinWeeks'), sb.readSheet_('DutyOverride'), sb.readSheet_('AuditLog')]); };
  const before = snapshot();
  [undefined, 1, '2'].forEach(function (version) {
    const payload = { isoDate: W, lastSavedAt: tab.lastSavedAt, week: { PAGE_TITLE: '舊分頁的序樂' }, baseWeek: { PAGE_TITLE: tab.week.PAGE_TITLE || '' },
      dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '李小明' }], nextWeekDutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '陳大文' }] };
    if (version !== undefined) payload.payloadVersion = version;
    const resp = sb.apiSaveWeek(plain(payload));
    assert.strictEqual(resp.ok, false, String(version));
    assert.strictEqual(resp.error.code, 'CLIENT_OUTDATED');
    assert.strictEqual(resp.error.message, '介面版本已更新，請重新載入這一頁再儲存。');
  });
  assert.strictEqual(snapshot(), before, '一格都沒有寫');
  assert.strictEqual(conflictCount(sb, W), 1);
  assert.strictEqual(sb.readSheet_('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'CLIENT_OUTDATED'; }).length, 0,
    '預期情況，不寫 ErrorLog');
});

test('D9-14 沒有帶事奉格的 payload（自測機、亂行機、程式叫的儲存）不要求版本，照常儲存', function () {
  const sb = makeEnv();
  const tab = load(sb, W);
  const resp = sb.apiSaveWeek(plain({ isoDate: W, lastSavedAt: tab.lastSavedAt, week: { PAGE_TITLE: '新序樂' },
    baseWeek: { PAGE_TITLE: tab.week.PAGE_TITLE || '' }, dutyEdits: [] }));
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
});

test('D9-15 版本號前後端一致：Script.html 的 SAVE_PAYLOAD_VERSION 等於 WebAppSave.gs 的 SAVE_PAYLOAD_VERSION_，亦等於測試用的版本；buildSavePayload() 帶它', function () {
  const sb = makeEnv();
  const js = readSrc('src/ui/Script.html');
  const m = /var SAVE_PAYLOAD_VERSION = (\d+);/.exec(js);
  assert.ok(m, 'Script.html 要有 SAVE_PAYLOAD_VERSION');
  assert.strictEqual(Number(m[1]), sb.SAVE_PAYLOAD_VERSION_);
  assert.strictEqual(SAVE_PAYLOAD_VERSION, sb.SAVE_PAYLOAD_VERSION_);
  assert.ok(js.indexOf('payloadVersion: SAVE_PAYLOAD_VERSION') !== -1, 'buildSavePayload() 要帶版本');
});

// =====================================================================
// 前端：Script.html 的真正程式碼，在假 DOM 上執行
// =====================================================================

/** 假 DOM：getElementById 找不到就建立；元素有 dataset、style、querySelectorAll（只認 input[type="text"]）。 */
function makeFakeDom() {
  const elements = {};
  const docListeners = {};
  function makeEl(tag, className) {
    const classes = new Set(String(className || '').split(' ').filter(Boolean));
    const node = {
      tag: tag, children: [], textContent: '', value: '', checked: false, disabled: false,
      type: '', open: false, attrs: {}, listeners: {}, dataset: {}, style: {}, title: '', placeholder: '',
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
      querySelectorAll: function (selector) {
        assert.strictEqual(selector, 'input[type="text"]', '假 DOM 只認 input[type="text"]');
        const out = [];
        (function walk(n) {
          (n.children || []).forEach(function (c) {
            if (c.tag === 'input' && c.type === 'text') out.push(c);
            walk(c);
          });
        })(node);
        return out;
      },
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
  return { document: document, makeEl: makeEl, elements: elements };
}

/** 假 google.script.run：每一個呼叫記下來，由測試決定回應。 */
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
 * 一個連住後端 sandbox 的填寫介面：載入、儲存、重讀職事表都把前端送出的請求原樣交給後端的真正入口。
 * 表單欄位用 ctx.form 代替（collectWeekFieldsFromForm() 的替身讀它）；與事奉框無關的畫面用替身。
 */
function makeUi(sb) {
  const js = readSrc('src/ui/Script.html');
  const dom = makeFakeDom();
  const calls = [];
  const noop = function () {};
  const ctx = {
    console: console,
    google: makeFakeGoogle(calls),
    document: dom.document,
    window: { addEventListener: noop },
    setTimeout: function () { return 0; },
    clearTimeout: noop,
    el: function (tag, className) { return dom.makeEl(tag, className); },
    escapeHtml: function (t) { return String(t); },
    state: {
      isoDate: null, showArchived: false, quarters: [], quarterId: null, lastSavedAt: null,
      loaded: false, inFlight: 0, previewInFlight: 0, week: {}, loadedWeek: {}, snapshotsLoadedFor: null,
      dutyEdits: {}, nextWeekDutyEdits: {}, loadedDutyNames: {}, loadedNextDutyNames: {},
      speakerForm: null, fetchCandidates: [], quarterOps: null, flowerRoster: { thisWeek: '', nextWeek: '' },
      publish: { pdfBase64: '', pdfName: '', pdfIsoDate: '', panel: null, confirmButton: '' }
    },
    form: { PAGE_TITLE: '' },
    collectWeekFieldsFromForm: function () { return Object.assign({}, ctx.form); },
    applyWeekFieldsToForm: function () { ctx.form = { PAGE_TITLE: String(ctx.state.week.PAGE_TITLE || '') }; },
    CONTENT_SHEET_WEEK_FIELDS: [],
    syncSelectorsTo: noop, renderRosterGapBanner: noop, populateSelectOptions: noop, populatePrayerHeadingOptions: noop,
    renderAllLists: noop, renderStats: noop, renderConflictStat: noop, renderFillGridLink: noop, renderPreviewLink: noop,
    renderWordFileInfo: noop, refreshSnapshotPanel: noop, renderProgramPreview: noop, applyContentSheetReadOnly: noop,
    adoptReadOnlyFields: noop, applyBaptismPanelVisibility: noop, renderFlowerHints: noop, resetPublishPanelIfWeekChanged: noop,
    refreshWeekSelectorLabels: noop,
    onWeekSelectChanged: noop, onQuarterChanged: noop, onShowArchivedChanged: noop, stepWeek: noop, backfillRoster: noop,
    openFetchFromRosterDialog: noop, cancelFetchFromRoster: noop, confirmFetchFromRoster: noop, setAllFetchCheckboxes: noop,
    applyPublishSubStates: noop, savePublishPrefs: noop, onPublishPdfChosen: noop, wireQuarterOpsEvents: noop,
    runPublish: noop, downloadWord: noop, isSnapshotPanelOpen: function () { return false; }, loadSnapshotPanel: noop,
    onResetWeekClicked: noop, onSpeakerFormCreateClicked: noop, onSpeakerFormRefreshClicked: noop,
    onSpeakerFormCopyClicked: noop, settleConfirmDialog: noop, onConfirmDialogKeydown: noop, cancelPublishConfirm: noop,
    schedulePreviewRefresh: noop, setPublishButtonsBusy: noop,
    // v3：wireStaticEvents() 新接的幾粒（與事奉框無關）。
    copyPreviewLink: noop, confirmProgramAdd: noop, closeProgramAddForm: noop, refreshUnsavedIndicator: noop,
    updateSnapshotButtons: noop, selectedSnapshotId: function () { return ''; }, onSnapshotDiffClicked: noop,
    onSnapshotRestoreClicked: noop, renderPublishWindow: noop, renderDutyDiffNotice: noop, renderRosterAppLink: noop,
    // 2026-10-30：特別崇拜（與事奉框無關）。
    toggleSpecialServiceForm: noop, startCreateSpecialService: noop, startCancelSpecialService: noop, renderSpecialServiceBanner: noop,
    renderRosterCombinedLink: noop
  };
  vm.createContext(ctx);
  const code = [
    region(js, 'message-bar'),
    between(js, 'function setLoaded(', '// BEGIN call-server'),
    region(js, 'call-server'),
    // 審查後修正 7：「重讀職事表」有未儲存的事奉改動時用真正的頁內確認對話框。
    region(js, 'confirm-dialog'),
    region(js, 'load-week'),
    between(js, 'function onWeekLoaded(', 'function renderPreviewLink('),
    between(js, 'function renderReadOnly(', 'function renderNextWeekDutyBox('),
    between(js, 'function renderNextWeekDutyBox(', '// 內容表接管的七個區塊'),
    between(js, 'function renderEditableDutyBox(', '// BEGIN duty-slot'),
    region(js, 'duty-slot'),
    between(js, 'function makeSmallButton(', 'function moveListItem('),
    region(js, 'week-diff'),
    region(js, 'week-switch-guard'),
    between(js, 'function reloadRosterOnly(', 'function buildSavePayload('),
    between(js, 'function buildSavePayload(', 'function refreshWeekSelectorLabels('),
    between(js, 'function wireStaticEvents(', 'function wireGlobalErrorHandlers(')
  ].join('\n');
  vm.runInContext(code, ctx);
  ctx.wireStaticEvents();

  function take(name) {
    const c = calls.filter(function (x) { return x.name === name && !x.taken; })[0];
    assert.ok(c, '沒有送出 ' + name + '；已送出：' + calls.map(function (x) { return x.name; }).join('、'));
    c.taken = true;
    return c;
  }
  /** 回應前端剛送出的 apiLoadWeek（真正入口的回應）。 */
  function answerLoad() {
    const c = take('apiLoadWeek');
    c.ok(plain(sb.apiLoadWeek(c.args[0])));
  }
  return {
    ctx: ctx, dom: dom, calls: calls, take: take,
    open: function (iso) { ctx.loadWeek(iso); answerLoad(); assert.strictEqual(ctx.state.loaded, true, '前提：載入成功'); },
    /** 按「儲存」，把送出的 payload 交給後端；成功的話前端會重新載入，亦一併回應。回傳 {payload, resp}。 */
    clickSave: function () {
      dom.document.getElementById('saveBtn').listeners.click({});
      const c = take('apiSaveWeek');
      const payload = plain(c.args[0]);
      const resp = plain(sb.apiSaveWeek(payload));
      c.ok(resp);
      if (resp.ok) answerLoad();
      return { payload: payload, resp: resp };
    },
    /** 按一粒 wireStaticEvents() 接上的真按鈕（不自動回應伺服器）。 */
    click: function (id) {
      const node = dom.document.getElementById(id);
      assert.ok(node.listeners.click, '#' + id + ' 沒有接上 click');
      node.listeners.click({ target: node });
    },
    /** 頁內確認對話框是不是開着；開着的話回傳標題與內文。 */
    dialog: function () {
      const backdrop = dom.elements.confirmDialogBackdrop;
      if (!backdrop || backdrop.classList.contains('hidden')) return null;
      return {
        title: dom.elements.confirmDialogTitle.textContent,
        lines: dom.elements.confirmDialogBody.children.map(function (c) { return c.textContent; })
      };
    },
    /** 按「由職事表重新取數（不覆寫）」（v3 取代頂部的「重讀職事表」；wireStaticEvents() 接上的真按鈕）。 */
    clickReloadRoster: function () {
      dom.document.getElementById('fetchFromRosterBtn').listeners.click({});
      answerLoad();
    },
    /** 某一個事奉框（'dutyBoxPage1Body' 或 'nextWeekDutyBody'）第一行的第一格。 */
    slot: function (containerId) {
      const container = dom.document.getElementById(containerId);
      const row = container.children[0];
      assert.ok(row, containerId + ' 沒有任何一行');
      const slotsWrap = row.children.filter(function (c) { return c.className === 'duty-row-slots'; })[0];
      const wrap = slotsWrap.children[0];
      function button(text) { return wrap.children.filter(function (c) { return c.tag === 'button' && c.textContent === text; })[0] || null; }
      const input = wrap.children.filter(function (c) { return c.tag === 'input'; })[0];
      return {
        wrap: wrap, input: input, row: row,
        keepButton: function () { return button('保留我的') || button('取消保留'); },
        restoreButton: function () { return button('還原'); },
        hint: function () {
          const h = wrap.children.filter(function (c) { return c.className === 'duty-keep-hint'; })[0];
          return h ? h.textContent : null;
        },
        type: function (text) { input.value = text; input.listeners.input({ target: input }); },
        click: function (btn) { assert.ok(btn, '沒有那一粒按鈕'); btn.listeners.click({}); }
      };
    },
    message: function () {
      const bar = dom.elements.messageBar;
      if (!bar || bar.classList.contains('hidden') || bar.children.length === 0) return null;
      return bar.children[0].textContent;
    }
  };
}

console.log('\n前端（按鈕路徑，連住後端真正入口）');

test('D9-16 載入有衝突的一週 → 只改序樂按「儲存」→ 兩個事奉框都一格不送、帶版本 2；後端衝突保留', function () {
  const sb = makeConflictEnv();
  const ui = makeUi(sb);
  ui.open(W);
  assert.strictEqual(ui.ctx.hasUnsavedWeekChanges(), false, '前提：剛載入沒有改動');
  ui.ctx.form.PAGE_TITLE = '新序樂';
  assert.strictEqual(ui.ctx.hasUnsavedWeekChanges(), true);
  const r = ui.clickSave();
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.strictEqual(r.payload.payloadVersion, 2);
  assert.deepStrictEqual(r.payload.dutyEdits, []);
  assert.deepStrictEqual(r.payload.nextWeekDutyEdits, []);
  assert.deepStrictEqual(r.payload.week, { PAGE_TITLE: '新序樂' });
  assert.strictEqual(conflictCount(sb, W), 1, '衝突保留');
  assert.strictEqual(ui.message(), '已儲存，更新了 1 個欄位。');
});

test('D9-17 衝突格有「保留我的」：按了 → 算未儲存、按鈕變「取消保留」、提示改講已選擇保留 → 按「儲存」送 keepOverride:true → 後端衝突解除而名字不變；重新載入之後不再是衝突、沒有保留按鈕', function () {
  const sb = makeConflictEnv();
  const ui = makeUi(sb);
  ui.open(W);
  const s = ui.slot('dutyBoxPage1Body');
  assert.ok(s.row.classList.contains('is-conflict'), '前提：那一行是衝突');
  assert.strictEqual(s.keepButton().textContent, '保留我的');
  assert.strictEqual(s.hint(), ui.ctx.DUTY_KEEP_HINT_OFF);
  s.click(s.keepButton());
  assert.strictEqual(s.keepButton().textContent, '取消保留');
  assert.ok(s.wrap.classList.contains('is-kept'));
  const keptHint = s.hint();
  assert.strictEqual(keptHint, '已選擇保留「李小明」，按「儲存」之後生效；要改主意就按「取消保留」。');
  assert.strictEqual(ui.ctx.hasUnsavedWeekChanges(), true, '按了保留算未儲存的改動（換週會先問）');
  const r = ui.clickSave();
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.deepStrictEqual(r.payload.dutyEdits, [{ postId: 'CHAIR', slotIndex: 1, name: '李小明', baseName: '李小明', keepOverride: true }]);
  assert.strictEqual(conflictCount(sb, W), 0, '衝突解除');
  assert.strictEqual(activeChair(sb, W).OVERRIDE_NAME, '李小明');
  const after = ui.slot('dutyBoxPage1Body');
  assert.strictEqual(after.row.classList.contains('is-conflict'), false);
  assert.strictEqual(after.keepButton(), null);
  assertWrittenChinese(assert, 'D9 保留提示', [ui.ctx.DUTY_KEEP_HINT_OFF, keptHint, ui.ctx.DUTY_CAUGHT_UP_HINT]);
});

test('D9-18 「取消保留」撤回 → 不再算未儲存、儲存時不送；保留之後改名或按「還原」亦自動撤回（送的是新名字／職事表的名字，沒有 keepOverride）', function () {
  const sb = makeConflictEnv();
  const ui = makeUi(sb);
  ui.open(W);
  const s = ui.slot('dutyBoxPage1Body');
  s.click(s.keepButton());
  s.click(s.keepButton());
  assert.strictEqual(s.keepButton().textContent, '保留我的');
  assert.strictEqual(ui.ctx.hasUnsavedWeekChanges(), false);
  assert.deepStrictEqual(plain(ui.ctx.buildSavePayload().dutyEdits), []);

  s.click(s.keepButton());
  s.type('王五');
  assert.strictEqual(s.keepButton().textContent, '保留我的', '改名自動撤回保留');
  assert.deepStrictEqual(plain(ui.ctx.buildSavePayload().dutyEdits), [{ postId: 'CHAIR', slotIndex: 1, name: '王五', baseName: '李小明' }]);

  s.type('李小明');
  s.click(s.keepButton());
  s.click(s.restoreButton());
  assert.strictEqual(s.keepButton().textContent, '保留我的', '還原自動撤回保留');
  assert.strictEqual(s.input.value, '張三');
  const r = ui.clickSave();
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  // 審查後修正 1：「還原」有覆寫的格另帶 followRoster:true（以前只送名字）。
  assert.deepStrictEqual(r.payload.dutyEdits, [{ postId: 'CHAIR', slotIndex: 1, name: '張三', baseName: '李小明', followRoster: true }]);
  assert.strictEqual(activeChair(sb, W), null, '改回職事表的名字＝取消覆寫');
  assert.strictEqual(conflictCount(sb, W), 0);
});

test('D9-19 分頁開着期間職事表換人 → 只改序樂按「儲存」→ 沒有新覆寫；儲存之後前端重新載入，事奉框顯示職事表的新名字；名字只加了空白不算改動', function () {
  const sb = makeEnv();
  const ui = makeUi(sb);
  ui.open(W);
  const s = ui.slot('dutyBoxPage1Body');
  assert.strictEqual(s.input.value, '陳大文');
  s.type('陳大文 ');
  assert.strictEqual(ui.ctx.hasUnsavedWeekChanges(), false, '只多了空白，不算改動');
  rosterChangesChair(sb, W, '張三');
  ui.ctx.form.PAGE_TITLE = '新序樂';
  const r = ui.clickSave();
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.deepStrictEqual(r.payload.dutyEdits, []);
  assert.deepStrictEqual(overrideRows(sb, W), []);
  assert.strictEqual(ui.slot('dutyBoxPage1Body').input.value, '張三', '重新載入之後是職事表的新名字');
});

test('D9-20 職事表已經追上覆寫的衝突格：不顯示「保留我的」，改為講明下次儲存會自動改回；只改序樂儲存 → 後端自動停用', function () {
  const sb = makeEnv();
  save(sb, W, { duty: { 'CHAIR#1': '李小明' } });
  rosterChangesChair(sb, W, '李小明');
  rewindLastSavedAt(sb, W, '2026-10-02');
  const ui = makeUi(sb);
  ui.open(W);
  const s = ui.slot('dutyBoxPage1Body');
  assert.ok(s.row.classList.contains('is-conflict'), '前提：覆寫對照的職事表值（陳大文）與現在（李小明）不同，算衝突');
  assert.strictEqual(s.keepButton(), null);
  assert.strictEqual(s.hint(), ui.ctx.DUTY_CAUGHT_UP_HINT);
  ui.ctx.form.PAGE_TITLE = '新序樂';
  const r = ui.clickSave();
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.deepStrictEqual(r.payload.dutyEdits, []);
  assert.strictEqual(activeChair(sb, W), null);
  assert.strictEqual(ui.slot('dutyBoxPage1Body').row.classList.contains('is-conflict'), false);
});

test('D9-21 下週事奉框：衝突格同樣有「保留我的」→ 送 nextWeekDutyEdits 的 keepOverride → W+7 衝突解除；本週框一格都不送', function () {
  const sb = makeNextConflictEnv();
  const ui = makeUi(sb);
  ui.open(W);
  const s = ui.slot('nextWeekDutyBody');
  assert.strictEqual(s.keepButton().textContent, '保留我的');
  s.click(s.keepButton());
  const r = ui.clickSave();
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.deepStrictEqual(r.payload.dutyEdits, []);
  assert.deepStrictEqual(r.payload.nextWeekDutyEdits, [{ postId: 'CHAIR', slotIndex: 1, name: '下週李', baseName: '下週李', keepOverride: true }]);
  assert.strictEqual(conflictCount(sb, W_AFTER), 0);
  assert.strictEqual(activeChair(sb, W_AFTER).OVERRIDE_NAME, '下週李');
  assert.deepStrictEqual(overrideRows(sb, W), []);
});

test('D9-22 按「重讀職事表」之後，事奉框按職事表的新名字重畫，「載入時的名字」跟着換：不算未儲存、儲存不送那一格', function () {
  const sb = makeEnv();
  const ui = makeUi(sb);
  ui.open(W);
  rosterChangesChair(sb, W, '張三');
  ui.clickReloadRoster();
  const s = ui.slot('dutyBoxPage1Body');
  assert.strictEqual(s.input.value, '張三');
  assert.strictEqual(ui.ctx.hasUnsavedWeekChanges(), false);
  assert.deepStrictEqual(plain(ui.ctx.buildSavePayload().dutyEdits), []);
});

test('D9-23 changedDutyEdits()：名字去空白比較、keepOverride 只認布林 true、改了名字的格不帶 keepOverride（與測試用的 changedDutyCells() 同一套規則）', function () {
  const sb = makeEnv();
  const ui = makeUi(sb);
  const edits = {
    'A#1': { postId: 'A', slotIndex: 1, name: '甲', keepOverride: false },
    'B#1': { postId: 'B', slotIndex: 1, name: ' 乙 ', keepOverride: false },
    'C#1': { postId: 'C', slotIndex: 1, name: '丙', keepOverride: true },
    'D#1': { postId: 'D', slotIndex: 1, name: '新丁', keepOverride: true },
    'E#1': { postId: 'E', slotIndex: 1, name: '戊', keepOverride: 'true' }
  };
  const loaded = { 'A#1': '甲', 'B#1': '乙', 'C#1': '丙', 'D#1': '丁', 'E#1': '戊' };
  assert.deepStrictEqual(plain(ui.ctx.changedDutyEdits(edits, loaded)), [
    { postId: 'C', slotIndex: 1, name: '丙', baseName: '丙', keepOverride: true },
    { postId: 'D', slotIndex: 1, name: '新丁', baseName: '丁' }
  ]);
});

test('D9-24 computeDutyOverridePlan_()（純函式）：沒有送來的格只做自動停用——職事表追上了、或覆寫名字是空白才停用；職事表現值是空白不停用；同一格兩行生效中的都停用', function () {
  const sb = makeEnv();
  const row = function (rowNo, postId, name, active) {
    return { __rowNo: rowNo, POST_ID: postId, SLOT_INDEX: 1, OVERRIDE_NAME: name, ROSTER_VALUE_AT_OVERRIDE: '舊', ROSTER_VERSION_AT_OVERRIDE: 1, ACTIVE: active };
  };
  const plan = plain(sb.computeDutyOverridePlan_({
    edits: [],
    existingRows: [row(3, 'A', '甲', true), row(4, 'B', '', true), row(5, 'C', '丙', true), row(6, 'D', '丁', true),
      row(7, 'D', '丁', true), row(8, 'E', '戊', false), row(9, 'F', '己', true)],
    rosterNameByKey: { 'A#1': '甲', 'B#1': '某人', 'C#1': '', 'D#1': '丁', 'E#1': '戊', 'F#1': '庚' },
    rosterVersion: 2
  }));
  assert.deepStrictEqual(plan.updates, []);
  assert.deepStrictEqual(plan.appends, []);
  assert.deepStrictEqual(plan.deactivations.map(function (d) { return d.rowNo + ':' + d.autoCaughtUp; }),
    ['3:true', '4:true', '6:true', '7:true'], JSON.stringify(plan.deactivations));
  assert.strictEqual(sb.dutyDeactivationKeepsDisplay_({ oldValue: '' }), true, '空白覆寫停用之後畫面不變');
  assert.strictEqual(sb.dutyDeactivationKeepsDisplay_({ oldValue: '甲', rosterName: '甲' }), true);
  assert.strictEqual(sb.dutyDeactivationKeepsDisplay_({ oldValue: '甲' }), false, '重設、還原的計畫沒有 rosterName：照舊當作會變');
  assert.strictEqual(sb.dutyDeactivationNote_({ oldValue: '', autoCaughtUp: true }).indexOf('人手覆寫的名字是空白'), 0);
  assert.strictEqual(sb.dutyDeactivationNote_({ oldValue: '甲', autoCaughtUp: false }), '取消人手覆寫（原值：甲），改回跟隨職事表。記錄保留，不刪行。');
  assertWrittenChinese(assert, 'D9 停用備註', [sb.dutyDeactivationNote_({ oldValue: '', autoCaughtUp: true }), sb.dutyDeactivationNote_({ oldValue: '甲', autoCaughtUp: true })]);

  // 送來的格照舊處理；那一格不會再被當成「沒有送來」而自動停用。
  const edited = plain(sb.computeDutyOverridePlan_({
    edits: [{ postId: 'A', slotIndex: 1, name: '新甲', baseName: '甲' }],
    existingRows: [row(3, 'A', '甲', true)], rosterNameByKey: { 'A#1': '甲' }, rosterVersion: 2
  }));
  assert.deepStrictEqual(edited.deactivations, []);
  assert.strictEqual(edited.updates[0].changes[0].newValue, '新甲');
});

// =====================================================================
// 審查後修正 1：分頁開着期間職事表換了人，再按「還原」
// =====================================================================

console.log('\n審查後修正 1：「還原」送明確意圖 followRoster');

/** W 的主席覆寫成李小明（職事表當時是陳大文），回傳 sandbox；之後由測試決定何時載入、何時改職事表。 */
function makeOverriddenEnv() {
  const sb = makeEnv();
  const made = save(sb, W, { duty: { 'CHAIR#1': '李小明' } });
  assert.strictEqual(made.resp.ok, true, JSON.stringify(made.resp.error));
  rewindLastSavedAt(sb, W, '2026-10-02');
  return sb;
}

test('RV1-1 對照組（應該紅）：分頁載入之後職事表把主席由陳大文改成張三，只送「還原」填的名字（載入時的陳大文）而沒有 followRoster → 後端照一般規則把陳大文釘成覆寫（這正是審查重現 R3，名字代表不了「改回跟隨職事表」）', function () {
  const sb = makeOverriddenEnv();
  const tab = load(sb, W);
  rosterChangesChair(sb, W, '張三');
  const r = save(sb, W, { tab: tab, duty: { 'CHAIR#1': chairSlot(tab, 'dutyBoxPage1').rosterName } });
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.strictEqual(activeChair(sb, W).OVERRIDE_NAME, '陳大文', '沒有 followRoster 就會釘死舊名字');
  assert.strictEqual(activeChair(sb, W).ROSTER_VALUE_AT_OVERRIDE, '張三');
});

test('RV1-2（審查重現 R3 改為通過）經 apiSaveWeek：同一情境帶 followRoster:true → 停用覆寫、不新增；重新載入顯示職事表現在的張三、沒有衝突；訊息算 1 個欄位；AuditLog 是幹事取消的備註', function () {
  const sb = makeOverriddenEnv();
  const tab = load(sb, W);
  rosterChangesChair(sb, W, '張三');
  const r = save(sb, W, { tab: tab, duty: { 'CHAIR#1': { name: chairSlot(tab, 'dutyBoxPage1').rosterName, followRoster: true } } });
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.deepStrictEqual(plain(r.payload.dutyEdits), [{ postId: 'CHAIR', slotIndex: 1, name: '陳大文', baseName: '李小明', followRoster: true }]);
  assert.strictEqual(activeChair(sb, W), null, '覆寫停用');
  assert.strictEqual(overrideRows(sb, W).length, 1, '不新增、不刪行');
  const slot = chairSlot(load(sb, W), 'dutyBoxPage1');
  assert.strictEqual(slot.bulletinName, '張三');
  assert.strictEqual(slot.hasOverride, false);
  assert.strictEqual(conflictCount(sb, W), 0);
  assert.strictEqual(r.resp.data.message.text, '已儲存，更新了 1 個欄位。');
  const audit = sb.readSheet_('AuditLog').filter(function (a) { return a.ACTION === 'DUTY_OVERRIDE_CLEAR'; });
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].NOTES, '取消人手覆寫（原值：李小明），改回跟隨職事表。記錄保留，不刪行。');
});

test('RV1-3 followRoster 只認布林 true：字串 "true" 當作沒有，照一般規則處理（與 keepOverride 同一規則）；沒有生效中的覆寫時 followRoster 甚麼都不寫', function () {
  const sb = makeOverriddenEnv();
  const tab = load(sb, W);
  rosterChangesChair(sb, W, '張三');
  const resp = sb.apiSaveWeek(plain({ isoDate: W, lastSavedAt: tab.lastSavedAt, payloadVersion: SAVE_PAYLOAD_VERSION,
    week: {}, baseWeek: {}, dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '陳大文', baseName: '李小明', followRoster: 'true' }] }));
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  assert.strictEqual(activeChair(sb, W).OVERRIDE_NAME, '陳大文', '字串不算明確意圖');

  const sb2 = makeEnv();
  const tab2 = load(sb2, W);
  const before = JSON.stringify([sb2.readSheet_('DutyOverride'), sb2.readSheet_('AuditLog')]);
  const resp2 = sb2.apiSaveWeek(plain({ isoDate: W, lastSavedAt: tab2.lastSavedAt, payloadVersion: SAVE_PAYLOAD_VERSION,
    week: {}, baseWeek: {}, dutyEdits: [{ postId: 'CHAIR', slotIndex: 1, name: '陳大文', baseName: '陳大文', followRoster: true }] }));
  assert.strictEqual(resp2.ok, true, JSON.stringify(resp2.error));
  assert.ok(resp2.data.message.text.indexOf('沒有偵測到任何改動') !== -1, resp2.data.message.text);
  assert.strictEqual(JSON.stringify([sb2.readSheet_('DutyOverride'), sb2.readSheet_('AuditLog')]), before, '一格都沒有寫');
});

test('RV1-4 computeDutyOverridePlan_()：followRoster 不看名字、不看職事表現值，那一格全部生效中的覆寫都停用（同一格兩行亦然）；不新增、不更新；與 keepOverride 同時是 true 以 followRoster 為準', function () {
  const sb = makeEnv();
  const row = function (rowNo, name, active) {
    return { __rowNo: rowNo, POST_ID: 'A', SLOT_INDEX: 1, OVERRIDE_NAME: name, ROSTER_VALUE_AT_OVERRIDE: '舊', ROSTER_VERSION_AT_OVERRIDE: 1, ACTIVE: active };
  };
  const plan = plain(sb.computeDutyOverridePlan_({
    edits: [{ postId: 'A', slotIndex: 1, name: '某個不同的名字', baseName: '甲', followRoster: true, keepOverride: true }],
    existingRows: [row(3, '甲', true), row(4, '甲', true), row(5, '乙', false)],
    rosterNameByKey: { 'A#1': '丙' }, rosterVersion: 2
  }));
  assert.deepStrictEqual(plan.updates, []);
  assert.deepStrictEqual(plan.appends, []);
  assert.deepStrictEqual(plan.deactivations.map(function (d) { return [d.rowNo, d.oldValue, d.rosterName, d.autoCaughtUp]; }),
    [[3, '甲', '丙', false], [4, '甲', '丙', false]]);
});

test('RV1-5 前端按鈕路徑：分頁載入之後職事表換人 → 對有覆寫的主席按「還原」→ 算未儲存、按「儲存」送 followRoster → 後端停用覆寫；儲存之後重新載入，輸入框是職事表現在的張三', function () {
  const sb = makeOverriddenEnv();
  const ui = makeUi(sb);
  ui.open(W);
  const s = ui.slot('dutyBoxPage1Body');
  assert.strictEqual(s.input.value, '李小明', '前提：載入時是覆寫的名字');
  rosterChangesChair(sb, W, '張三');
  s.click(s.restoreButton());
  assert.strictEqual(s.input.value, '陳大文', '「還原」填的是載入時的職事表名字');
  assert.strictEqual(ui.ctx.hasUnsavedWeekChanges(), true);
  const r = ui.clickSave();
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.deepStrictEqual(r.payload.dutyEdits, [{ postId: 'CHAIR', slotIndex: 1, name: '陳大文', baseName: '李小明', followRoster: true }]);
  assert.strictEqual(activeChair(sb, W), null);
  assert.strictEqual(overrideRows(sb, W).length, 1);
  assert.strictEqual(ui.slot('dutyBoxPage1Body').input.value, '張三');
  assert.strictEqual(ui.message(), '已儲存，更新了 1 個欄位。');
});

test('RV1-6 前端：「還原」之後改名 → 撤回 followRoster，送的是新名字；載入時沒有覆寫的格按「還原」只是改回，不送 followRoster、不算改動', function () {
  const sb = makeOverriddenEnv();
  const ui = makeUi(sb);
  ui.open(W);
  const s = ui.slot('dutyBoxPage1Body');
  s.click(s.restoreButton());
  s.type('王五');
  assert.deepStrictEqual(plain(ui.ctx.buildSavePayload().dutyEdits), [{ postId: 'CHAIR', slotIndex: 1, name: '王五', baseName: '李小明' }]);

  const sb2 = makeEnv();
  const ui2 = makeUi(sb2);
  ui2.open(W);
  const s2 = ui2.slot('dutyBoxPage1Body');
  s2.type('王五');
  s2.click(s2.restoreButton());
  assert.strictEqual(s2.input.value, '陳大文');
  assert.strictEqual(ui2.ctx.hasUnsavedWeekChanges(), false);
  assert.deepStrictEqual(plain(ui2.ctx.buildSavePayload().dutyEdits), []);
});

test('RV1-7 前端：衝突格按「還原」再按「保留我的」→ 輸入框填回你的名字、撤回 followRoster、送 keepOverride → 後端衝突解除而名字不變（不會把職事表名字釘成覆寫）', function () {
  const sb = makeConflictEnv();
  const ui = makeUi(sb);
  ui.open(W);
  const s = ui.slot('dutyBoxPage1Body');
  s.click(s.restoreButton());
  assert.strictEqual(s.input.value, '張三');
  s.click(s.keepButton());
  assert.strictEqual(s.input.value, '李小明', '保留的是你的名字');
  assert.strictEqual(s.hint(), '已選擇保留「李小明」，按「儲存」之後生效；要改主意就按「取消保留」。');
  const r = ui.clickSave();
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.deepStrictEqual(r.payload.dutyEdits, [{ postId: 'CHAIR', slotIndex: 1, name: '李小明', baseName: '李小明', keepOverride: true }]);
  assert.strictEqual(activeChair(sb, W).OVERRIDE_NAME, '李小明');
  assert.strictEqual(conflictCount(sb, W), 0);
});

test('RV1-8 下週事奉框：W 的分頁載入之後職事表把 W+7 的主席改了 → 在下週事奉框對有覆寫的主席按「還原」→ 送 nextWeekDutyEdits 的 followRoster → W+7 覆寫停用，W 一筆都沒有；重新載入顯示職事表的新名字', function () {
  const sb = makeEnv();
  const made = save(sb, W, { next: { 'CHAIR#1': '下週李' } });
  assert.strictEqual(made.resp.ok, true, JSON.stringify(made.resp.error));
  rewindLastSavedAt(sb, W, '2026-10-02');
  const ui = makeUi(sb);
  ui.open(W);
  const s = ui.slot('nextWeekDutyBody');
  assert.strictEqual(s.input.value, '下週李');
  rosterChangesChair(sb, W_AFTER, '下週張');
  s.click(s.restoreButton());
  const r = ui.clickSave();
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.deepStrictEqual(r.payload.dutyEdits, []);
  assert.deepStrictEqual(r.payload.nextWeekDutyEdits, [{ postId: 'CHAIR', slotIndex: 1, name: '陳大文', baseName: '下週李', followRoster: true }]);
  assert.strictEqual(activeChair(sb, W_AFTER), null);
  assert.deepStrictEqual(overrideRows(sb, W), []);
  assert.strictEqual(ui.slot('nextWeekDutyBody').input.value, '下週張');
});

test('RV1-9 changedDutyEdits()：followRoster 只認布林 true；帶 followRoster 的格即使名字與載入時相同亦送，而且不帶 keepOverride（與 changedDutyCells() 同一套規則）', function () {
  const sb = makeEnv();
  const ui = makeUi(sb);
  const edits = {
    'A#1': { postId: 'A', slotIndex: 1, name: '甲', keepOverride: false, followRoster: true },
    'B#1': { postId: 'B', slotIndex: 1, name: '乙', keepOverride: true, followRoster: true },
    'C#1': { postId: 'C', slotIndex: 1, name: '丙', keepOverride: false, followRoster: 'true' }
  };
  const loaded = { 'A#1': '甲', 'B#1': '乙', 'C#1': '丙' };
  assert.deepStrictEqual(plain(ui.ctx.changedDutyEdits(edits, loaded)), [
    { postId: 'A', slotIndex: 1, name: '甲', baseName: '甲', followRoster: true },
    { postId: 'B', slotIndex: 1, name: '乙', baseName: '乙', followRoster: true }
  ]);
});

// =====================================================================
// 審查後修正 5：自測機、亂行機的儲存不碰下一個主日（W+7）
// =====================================================================

console.log('\n審查後修正 5：沒有 nextWeekDutyEdits 的儲存不碰 W+7');

const OUTSIDE_SANDBOX = '2027-12-05';   // 2027T4 最後一個主日的下一個主日，不在沙盒季度之內

/** 在某一個主日放一筆生效中、名字空白的覆寫（GG-3：任何一次碰到它的儲存都會自動停用）。 */
function putBlankOverride(sb, iso) {
  sb.writeSheet_('DutyOverride', [{ SERVICE_DATE: sb.normalizeDate_(iso), POST_ID: 'CHAIR', SLOT_INDEX: 1, OVERRIDE_NAME: '',
    ROSTER_VALUE_AT_OVERRIDE: '陳大文', ROSTER_VERSION_AT_OVERRIDE: 1, ACTIVE: true }]);
}
function auditRowsFor(sb, iso) {
  return sb.readSheet_('AuditLog').filter(function (a) { return String(a.ROW_KEY || '').indexOf(iso) === 0; });
}

test('RV5-1 經 apiSaveWeek：payload 沒有 nextWeekDutyEdits 這個鍵 → W+7 生效中的覆寫不動（連自動停用也不做）、W+7 沒有版本記錄與 AuditLog；帶空陣列（填寫介面）→ 照舊自動停用', function () {
  const sb = makeEnv();
  save(sb, W, { next: { 'CHAIR#1': '下週李' } });
  rosterChangesChair(sb, W_AFTER, '下週李');   // 職事表追上：任何一次碰到 W+7 的儲存都會自動停用
  rewindLastSavedAt(sb, W, '2026-10-02');
  const tab = load(sb, W);
  const auditBefore = auditRowsFor(sb, W_AFTER).length;
  const snapshotsBefore = sb.readSheet_('WeekSnapshots').length;
  const resp = sb.apiSaveWeek(plain({ isoDate: W, lastSavedAt: tab.lastSavedAt, week: { PAGE_TITLE: '自測序樂' },
    baseWeek: { PAGE_TITLE: tab.week.PAGE_TITLE || '' }, dutyEdits: [] }));
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  assert.ok(activeChair(sb, W_AFTER), 'W+7 的覆寫仍然生效');
  assert.strictEqual(auditRowsFor(sb, W_AFTER).length, auditBefore, 'W+7 沒有 AuditLog');
  assert.strictEqual(sb.readSheet_('WeekSnapshots').length - snapshotsBefore, 1, '只有 W 一個版本');
  assert.strictEqual(resp.data.message.text, '已儲存，更新了 1 個欄位。');

  // 對照：填寫介面一定帶 nextWeekDutyEdits（空陣列）→ 照舊自動停用（D9-12 的行為）。
  const r = save(sb, W, { patch: { PAGE_TITLE: '介面序樂' } });
  assert.strictEqual(r.resp.ok, true, JSON.stringify(r.resp.error));
  assert.deepStrictEqual(r.payload.nextWeekDutyEdits, []);
  assert.strictEqual(activeChair(sb, W_AFTER), null);
});

test('RV5-2 真正入口：亂行機「經填寫介面改幾格」揀中沙盒季度最後一個主日 → 下一個主日（沙盒之外）的覆寫與記錄一格都不動', function () {
  const sb = makeEnv();
  putBlankOverride(sb, OUTSIDE_SANDBOX);
  const before = JSON.stringify(overrideRows(sb, OUTSIDE_SANDBOX));
  const editFields = sb.monkeyActions_().filter(function (a) { return a.id === 'EDIT_FIELDS'; })[0];
  const config = { quarterId: QUARTER_ID };
  const dates = plain(sb.selfTestSandboxDates_(config));
  assert.strictEqual(dates[dates.length - 1], '2027-11-28', '前提：沙盒最後一個主日');
  assert.strictEqual(sb.addDaysToIsoDate_('2027-11-28', 7), OUTSIDE_SANDBOX);
  assert.strictEqual(dates.indexOf(OUTSIDE_SANDBOX), -1, '前提：W+7 不在沙盒之內');
  const result = editFields.run({
    config: config, runId: 'RV5', stepNo: 1,
    // 第一次揀主日（揀最後一個），之後揀改幾格（0＝一格）。
    random: { nextInt: (function () { let n = 0; return function (k) { n++; return n === 1 ? k - 1 : 0; }; })() }
  });
  assert.ok(String(result.summary || result.detail || JSON.stringify(result)).indexOf('2027-11-28') !== -1, JSON.stringify(result));
  assert.strictEqual(JSON.stringify(overrideRows(sb, OUTSIDE_SANDBOX)), before, '沙盒之外的覆寫一格都沒有改');
  assert.strictEqual(auditRowsFor(sb, OUTSIDE_SANDBOX).length, 0, '沙盒之外沒有 AuditLog');
});

// =====================================================================
// 審查後修正 7：「重讀職事表」有未儲存的事奉改動時先問
// =====================================================================

console.log('\n審查後修正 7：「重讀職事表」不再靜靜丟掉未儲存的事奉改動');

// v3（Ivan 測試結果 A 第 7 項）：頂部「重讀職事表」改為事奉框內的「由職事表重新取數（不覆寫）」，確認句跟着改。
const RV7_PROMPT = '重新讀取會按職事表最新內容重新顯示事奉框，你未儲存的事奉改動會丟失，確定嗎？';

function apiLoadCount(ui) { return ui.calls.filter(function (c) { return c.name === 'apiLoadWeek'; }).length; }

test('RV7-1 沒有未儲存的事奉改動（只改了表單其他欄位）→ 按「重讀職事表」照舊直接讀，不出對話框；表單欄位不受影響', function () {
  const sb = makeEnv();
  const ui = makeUi(sb);
  ui.open(W);
  ui.ctx.form.PAGE_TITLE = '未儲存的序樂';
  const before = apiLoadCount(ui);
  ui.click('fetchFromRosterBtn');
  assert.strictEqual(ui.dialog(), null);
  assert.strictEqual(apiLoadCount(ui), before + 1, '直接送出');
  ui.take('apiLoadWeek').ok(plain(sb.apiLoadWeek(W)));
  assert.strictEqual(ui.ctx.form.PAGE_TITLE, '未儲存的序樂');
});

test('RV7-2 事奉框改了名字 → 按「重讀職事表」→ 出頁內確認對話框（那一句原文）、一個請求都未送；按「取消」→ 甚麼都不做：名字仍在、仍算未儲存、訊息列不變、沒有請求', function () {
  const sb = makeEnv();
  const ui = makeUi(sb);
  ui.open(W);
  ui.slot('dutyBoxPage1Body').type('王五');
  const messageBefore = ui.message();
  const before = apiLoadCount(ui);
  ui.click('fetchFromRosterBtn');
  assert.deepStrictEqual(ui.dialog(), { title: '重新讀取職事表', lines: [RV7_PROMPT] });
  assert.strictEqual(apiLoadCount(ui), before, '確認之前不送');
  ui.click('confirmCancelBtn');
  assert.strictEqual(ui.dialog(), null);
  assert.strictEqual(apiLoadCount(ui), before, '取消之後亦不送');
  assert.strictEqual(ui.slot('dutyBoxPage1Body').input.value, '王五');
  assert.strictEqual(ui.ctx.hasUnsavedWeekChanges(), true);
  assert.strictEqual(ui.message(), messageBefore, '取消不顯示訊息（與換週同一做法）');
  assertWrittenChinese(assert, 'RV7 確認句', [RV7_PROMPT]);
});

test('RV7-3 同一情境按「確定」→ 送出重讀；職事表已經換了人 → 事奉框按職事表重畫（張三），改動丟失，不再算未儲存', function () {
  const sb = makeEnv();
  const ui = makeUi(sb);
  ui.open(W);
  ui.slot('dutyBoxPage1Body').type('王五');
  rosterChangesChair(sb, W, '張三');
  ui.click('fetchFromRosterBtn');
  ui.click('confirmOkBtn');
  assert.strictEqual(ui.dialog(), null);
  ui.take('apiLoadWeek').ok(plain(sb.apiLoadWeek(W)));
  assert.strictEqual(ui.slot('dutyBoxPage1Body').input.value, '張三');
  assert.strictEqual(ui.ctx.hasUnsavedWeekChanges(), false);
});

test('RV7-4 下週事奉框的改動、本週衝突格按了「保留我的」、有覆寫的格按了「還原」亦算 → 先問', function () {
  const sbNext = makeEnv();
  const uiNext = makeUi(sbNext);
  uiNext.open(W);
  uiNext.slot('nextWeekDutyBody').type('下週王');
  uiNext.click('fetchFromRosterBtn');
  assert.ok(uiNext.dialog(), '下週事奉框的改動');

  const sbKeep = makeConflictEnv();
  const uiKeep = makeUi(sbKeep);
  uiKeep.open(W);
  const k = uiKeep.slot('dutyBoxPage1Body');
  k.click(k.keepButton());
  uiKeep.click('fetchFromRosterBtn');
  assert.ok(uiKeep.dialog(), '「保留我的」');

  const sbFollow = makeOverriddenEnv();
  const uiFollow = makeUi(sbFollow);
  uiFollow.open(W);
  const f = uiFollow.slot('dutyBoxPage1Body');
  f.click(f.restoreButton());
  uiFollow.click('fetchFromRosterBtn');
  assert.ok(uiFollow.dialog(), '「還原」');
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
