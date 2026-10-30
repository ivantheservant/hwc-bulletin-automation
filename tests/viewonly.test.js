#!/usr/bin/env node
/**
 * tests/viewonly.test.js
 *
 * 2026-10-30（Ivan）：填寫介面「只可以看」的用戶（Config WEBAPP_VIEWER_EMAILS）。
 *
 * 真正入口：每一個 api* 函式（經 withApiResult_()）、doGet 的樣板變數。
 *
 * 執行方式：node tests/viewonly.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeWordEnv } = require('./helpers/wordEnv');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); } catch (err) {
    fail++; console.log('  ✗ ' + name); console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n    ') : err));
  }
}

const D = '2027-11-07';

/** 呼叫者換成 `email`（部署者仍然是 tester@x.com）。 */
function as(env, email) {
  env.sandbox.Session.getActiveUser = function () { return { getEmail: function () { return email; } }; };
  return env;
}

function viewerEnv() {
  return as(makeWordEnv({ config: { WEBAPP_ALLOWED_EMAILS: 'editor@x.com, both@x.com', WEBAPP_VIEWER_EMAILS: 'viewer@x.com, both@x.com' } }), 'viewer@x.com');
}

function apiNames() {
  const dir = path.join(__dirname, '..', 'src');
  const names = [];
  fs.readdirSync(dir).filter(function (f) { return f.endsWith('.gs'); }).forEach(function (f) {
    (fs.readFileSync(path.join(dir, f), 'utf8').match(/^function (api[A-Z][A-Za-z]*)\(/gm) || []).forEach(function (m) {
      names.push(m.slice('function '.length, -1));
    });
  });
  return names;
}

console.log('\n名單');

test('VO-1 webAppRoleForEmail_：可以修改的名單優先；部署者永遠可以修改；只看名單；兩個都不在＝沒有權限；大小寫與空白不計', function () {
  const sb = makeWordEnv().sandbox;
  const f = sb.webAppRoleForEmail_;
  assert.strictEqual(f('editor@x.com', ['editor@x.com'], ['viewer@x.com'], 'dep@x.com'), 'EDIT');
  assert.strictEqual(f(' Viewer@X.com ', ['editor@x.com'], ['viewer@x.com'], 'dep@x.com'), 'VIEW');
  assert.strictEqual(f('both@x.com', ['both@x.com'], ['both@x.com'], 'dep@x.com'), 'EDIT');
  assert.strictEqual(f('dep@x.com', [], ['dep@x.com'], 'dep@x.com'), 'EDIT');
  assert.strictEqual(f('nobody@x.com', ['editor@x.com'], ['viewer@x.com'], 'dep@x.com'), 'NONE');
  assert.strictEqual(f('', [], [''], 'dep@x.com'), 'NONE');
});

console.log('\n真入口 api*');

test('VO-2 只看的用戶：載入、清單、程序預覽可以；儲存被擋（VIEW_ONLY，一格不寫、不記 ErrorLog）', function () {
  const env = viewerEnv();
  const sb = env.sandbox;
  assert.strictEqual(sb.apiListWeeks(false).ok, true);
  const load = sb.apiLoadWeek(D);
  assert.strictEqual(load.ok, true, JSON.stringify(load.error));
  const before = JSON.stringify(sb.readSheet('BulletinWeeks'));
  const errBefore = sb.readSheet('ErrorLog').length;
  const saved = sb.apiSaveWeek({ isoDate: D, lastSavedAt: load.data.lastSavedAt, payloadVersion: 2,
    week: { PRELUDE: '改了' }, baseWeek: { PRELUDE: '' }, announcements: [], prayers: [], fellowships: [], finance: [] });
  assert.strictEqual(saved.ok, false);
  assert.strictEqual(saved.error.code, 'VIEW_ONLY');
  assertWrittenChinese(assert, 'VIEW_ONLY', [saved.error.message]);
  assert.strictEqual(JSON.stringify(sb.readSheet('BulletinWeeks')), before);
  assert.strictEqual(sb.readSheet('ErrorLog').length, errBefore);
});

test('VO-3 預設擋住：不在白名單的每一個 api* 對只看的用戶一律回 VIEW_ONLY；白名單每一個都是真的 api 函式', function () {
  const env = viewerEnv();
  const sb = env.sandbox;
  const all = apiNames();
  const allowed = Array.from(sb.VIEW_ONLY_ALLOWED_APIS_);
  allowed.forEach(function (n) { assert.ok(all.indexOf(n) !== -1, '白名單有不存在的 api：' + n); });
  const blocked = all.filter(function (n) { return allowed.indexOf(n) === -1; });
  assert.ok(blocked.indexOf('apiSaveWeek') !== -1 && blocked.indexOf('apiRunPublish') !== -1 && blocked.indexOf('apiCancelSpecialService') !== -1);
  blocked.forEach(function (n) {
    const r = sb[n]();
    assert.strictEqual(r && r.ok, false, n);
    assert.strictEqual(r.error.code, 'VIEW_ONLY', n + '：' + JSON.stringify(r.error));
  });
});

test('VO-4 可以修改的用戶（兩個名單都有）不受影響；不在名單＝沒有權限（FORBIDDEN）', function () {
  const env = viewerEnv();
  as(env, 'both@x.com');
  assert.strictEqual(env.sandbox.callerWebAppRole_(), 'EDIT');
  assert.notStrictEqual((env.sandbox.apiCreateSpecialService('2027-11-12', '測試').error || {}).code, 'VIEW_ONLY');
  as(env, 'nobody@x.com');
  const r = env.sandbox.apiLoadWeek(D);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'FORBIDDEN');
});

console.log('\n前端');

test('VO-5 Index.html：#app 帶 data-view-only 樣板變數、有只看說明橫額；Script.html 白名單內每一個控制項都存在', function () {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Script.html'), 'utf8');
  assert.ok(html.indexOf('data-view-only="<?= viewOnly ?>"') !== -1);
  assert.ok(html.indexOf('id="viewOnlyTopBanner"') !== -1);
  const m = /var VIEW_ONLY_ALLOWED_CONTROL_IDS = \[([^\]]+)\]/.exec(js);
  assert.ok(m, '找不到白名單');
  m[1].split(',').map(function (s) { return s.trim().replace(/'/g, ''); }).filter(Boolean).forEach(function (id) {
    assert.ok(html.indexOf('id="' + id + '"') !== -1, 'Index.html 沒有 ' + id);
  });
  const gs = fs.readFileSync(path.join(__dirname, '..', 'src', 'WebApp.gs'), 'utf8');
  assert.ok(/template\.viewOnly = /.test(gs), 'doGet 要設 template.viewOnly（沒有設的話樣板會出錯）');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
