#!/usr/bin/env node
/**
 * tests/friendlymessages1104.test.js
 *
 * 2026-11-04（Ivan 測試結果 C）：「PersonDisplay 找不到…」這類提示對幹事太技術性（他們不會打開週報系統試算表）。
 *   src/FriendlyMessages.gs 把警告與 API 錯誤改寫成人話，原本的技術內容放 adminDetail；
 *   填寫介面收起來，標「給管理員參考」。
 *
 *   ⚠️ bug class 5：除純函式之外，由真正入口 apiLoadWeek() 叫一次（假職事表）。
 *
 * 執行方式：node tests/friendlymessages1104.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeFillEnv, QUARTER_ID } = require('./helpers/fillEnv');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); } catch (err) {
    fail++; console.log('  ✗ ' + name); console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n    ') : err));
  }
}

const TECH = /PersonDisplay|PersonID|NameMapping|Config|BulletinWeeks|ProgramTemplates|試算表|選單|[A-Z][A-Z0-9]*_[A-Z0-9_]+/;
const WEEK1 = '2027-11-07';
const POSTS = [
  { PostID: 'PREACHER', PostName_TC: '講員', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: false, DisplayOrder: 20, Active: true, EmptyDisplay: 'PENDING' },
  { PostID: 'CHAIR', PostName_TC: '主席', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: false, DisplayOrder: 10, Active: true, EmptyDisplay: 'PENDING' }
];
function assignment(iso, postId, personId, name) {
  return { QuarterID: QUARTER_ID, VersionNo: 3, ServiceDate: iso, PostID: postId, SlotIndex: 1,
    PersonID: personId || '', PersonNameSnapshot: name || '', AssignSource: 'AUTO', Locked: false, RuleFlags: '' };
}

const sb = makeFillEnv({ withGrid: false, rosterPosts: POSTS, rosterAssignments: [] }).sandbox;

console.log('\n純函式');

test('FM-1 已知代碼：句子不提工作表、PersonID；原本的一句在 adminDetail；代碼不變', function () {
  const raw = { code: 'NO_PERSON_DISPLAY', personId: 'P0042', name: '陳大文',
    message: 'PersonID「P0042」（陳大文）在週報的 PersonDisplay 工作表找不到生效中的一行，已直接用職事表的姓名快照，沒有加尊稱。請在 PersonDisplay 補上這個人的尊稱設定。' };
  const out = sb.toFriendlyWarning_(raw);
  assert.strictEqual(out.code, 'NO_PERSON_DISPLAY');
  assert.strictEqual(out.personId, 'P0042', '其他欄位原樣保留');
  assert.ok(out.message.indexOf('「陳大文」未有設定稱呼') === 0, out.message);
  assert.ok(!TECH.test(out.message), out.message);
  assert.strictEqual(out.adminDetail, raw.message);
  assert.strictEqual(raw.message.indexOf('PersonID'), 0, '不可以改動傳入的物件');
});

test('FM-2 人手覆寫的名字：講明訪客可以不理', function () {
  const out = sb.toFriendlyWarning_({ code: 'OVERRIDE_NAME_NOT_IN_PERSON_DISPLAY', name: '李訪客', message: '人手覆寫的姓名「李訪客」在週報的 PersonDisplay 工作表找不到生效中的一行…' });
  assert.ok(out.message.indexOf('「李訪客」') === 0 && out.message.indexOf('訪客可以不理') !== -1, out.message);
  assert.ok(!TECH.test(out.message), out.message);
});

test('FM-3 沒有專門寫法、亦沒有技術字眼 → 原物件照樣（不吞掉警告）', function () {
  const w = { code: 'CHOIR_NOT_IN_ROSTER', message: '職事表沒有把這一個主日設為詩班獻詩，但已填了詩班曲名「頌讚」（照樣會印）。' };
  assert.strictEqual(sb.toFriendlyWarning_(w), w);
  assert.strictEqual(sb.toFriendlyWarnings_([w]).length, 1);
});

test('FM-4 沒有專門寫法但有技術字眼：括號內的技術補充、叫人用選單的句子刪去；刪完仍然技術 → 通用的一句', function () {
  const a = sb.toFriendlyWarning_({ code: 'X_NEW', message: '尚未設定輸出資料夾（Config 的 BULLETIN_OUTPUT_FOLDER_ID），雲端硬碟沒有留存。請按選單「初始化工作表」。' });
  assert.strictEqual(a.message, '尚未設定輸出資料夾，雲端硬碟沒有留存。如有需要，請通知管理員。');
  const b = sb.toFriendlyWarning_({ code: 'X_NEW', message: 'TypeError: Cannot read properties of undefined' });
  assert.ok(b.message.indexOf('給管理員參考') !== -1 && !TECH.test(b.message), b.message);
  assert.strictEqual(b.adminDetail, 'TypeError: Cannot read properties of undefined');
});

test('FM-5 事奉格不夠：列出不會印的項目、下週講明日期', function () {
  const out = sb.toFriendlyWarning_({ code: 'NEXT_DUTY_SLOT_OVERFLOW', dropped: [{ label: '講員', text: '何牧師' }],
    message: '第 3 頁下週事奉（2027-11-14）有 2 項要印，但 Word 範本「平常主日」只有 1 格（01），以下 1 項不會印出：講員：何牧師。要在 Word 範本加格，或在職事表合併崗位。' });
  assert.strictEqual(out.message, '第 3 頁「下週事奉」（2027-11-14）有 2 項要印，但 Word 範本只有 1 格，以下 1 項不會印出：講員：何牧師。請通知管理員在 Word 範本加格。');
});

test('FM-6 API 錯誤：只可以看、結構落後、授權、程式例外都改寫；平常的句子不改', function () {
  assert.ok(sb.friendlyApiError_('VIEW_ONLY', '你在「只可以看」的名單（Config 的 WEBAPP_VIEWER_EMAILS）…').message.indexOf('只可以查看') !== -1);
  const schema = sb.friendlyApiError_('SCHEMA_OUTDATED', '工作表結構落後於程式碼（…），拒絕寄送。請先在試算表按「初始化工作表」。');
  assert.ok(!TECH.test(schema.message) && schema.adminDetail.indexOf('初始化工作表') !== -1, schema.message);
  assert.ok(sb.friendlyApiError_('ERROR', 'x　⚠️ 這是授權範圍問題。請按選單…').message.indexOf('重新授權') !== -1);
  const crash = sb.friendlyApiError_('ERROR', 'ReferenceError: foo is not defined');
  assert.ok(crash.message.indexOf('系統未能完成這個動作') === 0, crash.message);
  const plain = sb.friendlyApiError_('STALE', '這一週的資料在你載入之後被改過，請重新載入。');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(plain)), { message: '這一週的資料在你載入之後被改過，請重新載入。', adminDetail: '' });
});

test('FM-7 所有專門寫法：沒有技術字眼、是書面語', function () {
  const codes = fs.readFileSync(path.join(__dirname, '..', 'src', 'FriendlyMessages.gs'), 'utf8').match(/case '([A-Z_]+)'/g)
    .map(function (c) { return c.slice(6, -1); });
  assert.ok(codes.length >= 30, codes.length);
  const texts = codes.map(function (c) { return sb.friendlyWarningText_({ code: c, message: '', name: '陳大文', dropped: [] }); });
  texts.forEach(function (t, i) { assert.ok(t && !TECH.test(t.replace('{{…}}', '')), codes[i] + '：' + t); });
  assertWrittenChinese(assert, '人話提示', texts);
});

console.log('\n真正入口：apiLoadWeek()');

test('FM-8 職事表的人未有稱呼 → apiLoadWeek 的警告是人話，代碼、原句保留', function () {
  const env = makeFillEnv({ withGrid: false, rosterPosts: POSTS,
    rosterAssignments: [assignment(WEEK1, 'PREACHER', 'P0099', '黃牧師'), assignment(WEEK1, 'CHAIR', 'P0100', '陳大文')],
    weekRows: [{ SERVICE_DATE: WEEK1, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }] });
  const resp = env.sandbox.apiLoadWeek(WEEK1);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  const w = Array.from(resp.data.warnings).filter(function (x) { return x.code === 'NO_PERSON_DISPLAY'; });
  assert.ok(w.length >= 1, JSON.stringify(resp.data.warnings));
  w.forEach(function (x) {
    assert.ok(!TECH.test(x.message), x.message);
    assert.ok(/PersonDisplay/.test(x.adminDetail), x.adminDetail);
  });
});

test('FM-9 真正入口的錯誤：apiResetWeek 遇到週報未有的主日 → 人話，原句在 adminDetail', function () {
  const env = makeFillEnv({ withGrid: false });
  const r = env.sandbox.apiResetWeek({ isoDate: '2031-01-05' });
  assert.strictEqual(r.ok, false);
  assert.ok(!/試算表|選單/.test(r.error.message), r.error.message);
  assert.ok(/選單/.test(r.error.adminDetail), r.error.adminDetail);
});

console.log('\n填寫介面（Script.html 真正的程式碼）');

function loadUiPieces() {
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Script.html'), 'utf8');
  const msg = js.slice(js.indexOf('// BEGIN message-bar'), js.indexOf('// END message-bar'));
  const panel = js.slice(js.indexOf('function renderWarningsPanel('), js.indexOf('function renderConflictStat('));
  return msg + '\n' + panel;
}
function fakeEl(tag) {
  let html = '';
  const node = { tagName: tag, className: '', textContent: '', children: [], classList: { add: function () {}, remove: function () {}, contains: function () { return false; } },
    appendChild: function (c) { this.children.push(c); return c; }, setAttribute: function () {}, addEventListener: function () {} };
  Object.defineProperty(node, 'innerHTML', { get: function () { return html; }, set: function (v) { html = v; node.children = []; } });
  return node;
}

test('FM-10 訊息列：伺服器 ok:false 帶 adminDetail → 先顯示人話，再有收起來的「給管理員參考」', function () {
  const els = { messageBar: fakeEl('div'), warningsPanel: fakeEl('div'), statWarnings: fakeEl('span') };
  const ctx = { document: { getElementById: function (id) { return els[id]; }, createElement: fakeEl },
    el: function (t, c) { const n = fakeEl(t); if (c) n.className = c; return n; },
    escapeHtml: function (t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } };
  vm.createContext(ctx);
  vm.runInContext(loadUiPieces(), ctx);
  ctx.rememberAdminDetail({ ok: false, error: { code: 'X', message: '系統未能完成這個動作。', adminDetail: 'TypeError: boom' } });
  ctx.showMessage('error', '系統未能完成這個動作。');
  const bar = els.messageBar;
  assert.strictEqual(bar.children[0].textContent, '系統未能完成這個動作。');
  const box = bar.children.filter(function (c) { return c.className === 'admin-detail'; })[0];
  assert.ok(box, '要有「給管理員參考」');
  assert.strictEqual(box.children[0].textContent, '給管理員參考');
  assert.strictEqual(box.children[1].textContent, 'TypeError: boom');
  ctx.showMessage('info', '另一句');
  assert.strictEqual(bar.children.filter(function (c) { return c.className === 'admin-detail'; }).length, 0, '用過就清');

  ctx.renderWarningsPanel([{ code: 'NO_PERSON_DISPLAY', message: '「陳大文」未有設定稱呼', adminDetail: 'PersonID「P1」<x>' }]);
  assert.ok(els.warningsPanel.innerHTML.indexOf('<ul><li>「陳大文」未有設定稱呼<details class="admin-detail"><summary>給管理員參考</summary><div>PersonID「P1」&lt;x&gt;') === 0, els.warningsPanel.innerHTML);
  ctx.mergeExtraWarnings([{ code: 'NO_PERSON_DISPLAY', message: '「陳大文」未有設定稱呼' }, { code: 'YEAR_LOGO_UNREADABLE', message: '年度標誌未能放入' }]);
  assert.strictEqual(els.statWarnings.textContent, '警告 2 項', '同一句不重複、新的一句加入');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
