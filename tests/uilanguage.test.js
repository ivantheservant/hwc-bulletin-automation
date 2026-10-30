#!/usr/bin/env node
/**
 * tests/uilanguage.test.js
 *
 * 2026-10-30（Ivan）：填寫介面的文字一律用香港書面語繁體中文——不用口語廣東話字（嘅／呢／係／揀……）、
 * 不用台灣式用字（這裡→這裏、使用者→用戶）。掃 src/ui/*.html 內**使用者看得見的文字**（標籤、提示、按鈕、
 * title／placeholder、Script.html 的字串），註解不算（註解是寫給維護者看的）。
 *
 * 執行方式：node tests/uilanguage.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { findColloquial } = require('./helpers/writtenChinese');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); } catch (err) {
    fail++; console.log('  ✗ ' + name); console.log('    ' + (err && err.message ? err.message : err));
  }
}

/** 台灣式或口語的用字（香港書面語的寫法在括號）。 */
const AVOID_WORDS = ['這裡', '那裡', '哪裡', '見得返', '使用者', '點選', '螢幕', '軟體', '網路',
  // 2026-10-30（Ivan：新的語言設定）：口語或過份壓縮的寫法（香港書面語的寫法在括號）。
  '一齊',   // 一併／一起
  '取數',   // 讀取
  '先講',   // 先列出／先說明
  '講明',   // 說明
  '講清楚', // 說清楚
  '跟住',   // 隨之／跟隨
  '看晒',   // 看到全部
  '好返',   // 恢復
  '併埋'    // 合併
];

function readUi(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', name), 'utf8').replace(/\r\n/g, '\n');
}

/** HTML：拿走註解與 <script>…</script>／<style>…</style>，剩下標籤外的文字與 title／placeholder。 */
function visibleHtmlText(html) {
  const s = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  const out = [];
  (s.match(/>[^<>]+</g) || []).forEach(function (m) { out.push(m.slice(1, -1)); });
  (s.match(/(?:title|placeholder)="[^"]*"/g) || []).forEach(function (m) { out.push(m); });
  return out;
}

/** Script.html：拿走註解（行註解與區塊註解），剩下單引號字串。 */
function scriptStrings(js) {
  const noBlock = js.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  noBlock.split('\n').forEach(function (line) {
    if (/^\s*\/\//.test(line)) return;
    const code = line.replace(/\s\/\/.*$/, '');
    (code.match(/'(?:[^'\\\n]|\\.)*'/g) || []).forEach(function (m) { out.push(m.slice(1, -1)); });
  });
  return out;
}

function check(label, texts) {
  const problems = [];
  texts.forEach(function (t) {
    findColloquial(t).forEach(function (h) { problems.push('口語字「' + h.char + '」：' + h.context); });
    AVOID_WORDS.forEach(function (w) { if (t.indexOf(w) !== -1) problems.push('「' + w + '」：' + t.slice(0, 60)); });
  });
  assert.deepStrictEqual(problems, [], label + '\n' + problems.join('\n'));
}

console.log('\n填寫介面的文字（香港書面語）');

test('Index.html 看得見的文字', function () {
  const texts = visibleHtmlText(readUi('Index.html'));
  assert.ok(texts.length > 100, '應該抽到很多段文字（' + texts.length + '）');
  check('Index.html', texts);
});

test('Script.html 的字串', function () {
  const texts = scriptStrings(readUi('Script.html'));
  assert.ok(texts.length > 300, '應該抽到很多個字串（' + texts.length + '）');
  check('Script.html', texts);
});

test('FillConflict.html 看得見的文字與字串', function () {
  const html = readUi('FillConflict.html');
  check('FillConflict.html', visibleHtmlText(html).concat(scriptStrings((html.match(/<script>([\s\S]*?)<\/script>/) || ['', ''])[1])));
});

test('伺服器的字串（src/*.gs，對話框、訊息、說明、寫入試算表的文字）', function () {
  const dir = path.join(__dirname, '..', 'src');
  let count = 0;
  const problems = [];
  fs.readdirSync(dir).filter(function (f) { return f.endsWith('.gs'); }).forEach(function (f) {
    let texts = scriptStrings(fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n'))
      .filter(function (t) { return /[\u4e00-\u9fff]/.test(t); });
    // 例外：工作表的欄名（改了會與現有的試算表對不上）、照抄 Google 介面的字。
    count += texts.length;
    texts = texts.filter(function (t) { return t !== '使用者' && t.indexOf('網域內的使用者') === -1; });
    try { check(f, texts); } catch (err) { problems.push(err.message); }
  });
  assert.ok(count > 2000, '應該抽到很多個字串（' + count + '）');
  assert.deepStrictEqual(problems, [], problems.join('\n'));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
