#!/usr/bin/env node
/**
 * tests/utf8docx.test.js
 *
 * 2026-11-02（舊週報 2026T3／T4 核對）：家事報告「愛𥚃同行」（U+25683，BMP 以外）在產生的 Word 變成兩個「�」。
 * 工作表裏的字是對的；壞在 `Utilities.newBlob(字串)` 把代理對各自編成三個位元組（CESU-8）。
 * 改為 document.xml 一律經 `encodeUtf8Bytes_()` 編成 UTF-8 位元組再建 Blob。
 *
 * 執行方式：node tests/utf8docx.test.js
 */

'use strict';

const assert = require('assert');
const { makeWordEnv } = require('./helpers/wordEnv');
const { buildFakeDocx } = require('./helpers/fakeDrive');
const fx = require('./fixtures/docxXml');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); } catch (err) {
    fail++; console.log('  ✗ ' + name); console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n    ') : err));
  }
}
function u8(signed) { return Array.from(signed, function (b) { return b < 0 ? b + 256 : b; }); }

const sb = makeWordEnv({}).sandbox;

console.log('\nencodeUtf8Bytes_（純函式）');

test('U-1 ASCII、中文（三個位元組）、U+25683（四個位元組 F0 A5 9A 83）、emoji；與 Node 的 UTF-8 一致', function () {
  ['abc<>&', '愛同行', '愛\u{25683}同行', '\u{1F600}', ''].forEach(function (s) {
    assert.deepStrictEqual(u8(sb.encodeUtf8Bytes_(s)), Array.from(Buffer.from(s, 'utf8')), JSON.stringify(s));
  });
  assert.deepStrictEqual(u8(sb.encodeUtf8Bytes_('\u{25683}')), [0xF0, 0xA5, 0x9A, 0x83]);
  sb.encodeUtf8Bytes_('愛\u{25683}').forEach(function (b) { assert.ok(b >= -128 && b <= 127, '要是有號 byte：' + b); });
});

test('U-2 落單的代理（不成對）→ U+FFFD（EF BF BD），不會編出非法的 UTF-8', function () {
  assert.deepStrictEqual(u8(sb.encodeUtf8Bytes_('a\uD855b')), [0x61, 0xEF, 0xBF, 0xBD, 0x62]);
  assert.deepStrictEqual(u8(sb.encodeUtf8Bytes_('\uDE83')), [0xEF, 0xBF, 0xBD]);
  assert.deepStrictEqual(Array.from(sb.encodeUtf8Bytes_(null)), []);
});

console.log('\n真入口 generateBulletinDocx_');

test('U-3 家事報告有 U+25683：document.xml 的位元組是正確的四個位元組，讀回來是同一個字（不是兩個 �）', function () {
  const D = new Date(2027, 10, 7);
  const env = makeWordEnv({
    driveOptions: { files: { FAKE_TEMPLATE_ID_NORMAL: buildFakeDocx(fx.documentXml(
      fx.para(fx.run('{{SERMON_TITLE}}'))
      + fx.para(fx.run('{{#EACHP:ANNOUNCEMENT}}{{ANNOUNCEMENT.NO}}. {{ANNOUNCEMENT.TEXT}}'))
    )) } },
    weekRows: [
      { SERVICE_DATE: '2027-11-07', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT', SERMON_TITLE: '講題一' },
      { SERVICE_DATE: '2027-11-14', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 2, STATUS: 'DRAFT', SERMON_TITLE: '講題二' }
    ]
  });
  env.sandbox.writeSheet_('Announcements', [
    { SERVICE_DATE: D, SEQ_NO: 10, TEXT: '主題是「愛\u{25683}同行、活現基督」', ACTIVE: true }
  ]);
  const r = env.sandbox.generateBulletinDocx_('2027-11-07');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const doc = r.blob.__entries.filter(function (e) { return e.getName() === 'word/document.xml'; })[0];
  assert.ok(Array.isArray(doc.__bytes), 'document.xml 要由位元組建立，不可以直接傳字串給 Utilities.newBlob()');
  const bytes = Buffer.from(u8(doc.__bytes));
  assert.ok(bytes.indexOf(Buffer.from([0xF0, 0xA5, 0x9A, 0x83])) !== -1, '要有 U+25683 的 UTF-8 四個位元組');
  assert.ok(bytes.indexOf(Buffer.from([0xED])) === -1, '不可以有 CESU-8 的代理位元組（ED A? ??）');
  assert.ok(doc.getDataAsString().indexOf('愛\u{25683}同行') !== -1, doc.getDataAsString().slice(0, 300));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
