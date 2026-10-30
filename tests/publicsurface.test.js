#!/usr/bin/env node
/**
 * tests/publicsurface.test.js
 *
 * 2026-10-30（獨立審查第 1 項）：`google.script.run` 可以叫**任何**名稱不是底線結尾的全域函式，
 * 而且以部署者身分執行（appsscript.json executeAs USER_DEPLOYING）。以前 `setConfig`、`writeSheet`、
 * `readSheet`、`getConfig`、`initializeAllSheets` 是公開的——網域內任何人打開預覽頁，就可以在瀏覽器
 * 主控台改 Config（把自己加入 WEBAPP_ALLOWED_EMAILS）、寫任何工作表、讀收件人電郵。全部已改為底線結尾。
 *
 * 這個測試守住：src/*.gs 的公開函式只可以是下面幾個入口，以及經 withApiResult_() 把關的 api*。
 *
 * 執行方式：node tests/publicsurface.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); } catch (err) {
    fail++; console.log('  ✗ ' + name); console.log('    ' + (err && err.message ? err.message : err));
  }
}

const SRC = path.join(__dirname, '..', 'src');
const files = fs.readdirSync(SRC).filter(function (f) { return f.endsWith('.gs'); });

/** 可以公開的入口：Web App、樣板、簡單觸發器、編輯器授權（只檢查授權範圍，不讀寫資料）。 */
const ALLOWED_PUBLIC = ['doGet', 'include', 'onOpen', 'authorizeAllScopes'];
/** 已停用、一律回固定錯誤的 api（不讀寫任何資料）。 */
const RETIRED_API = ['apiGetSpeakerFormStatus', 'apiCreateSpeakerForm', 'apiRefreshSpeakerFormDates'];

function publicFunctions() {
  const out = [];
  files.forEach(function (f) {
    const s = fs.readFileSync(path.join(SRC, f), 'utf8');
    const re = /^function ([A-Za-z0-9_$]+)\s*\(/gm;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (!/_$/.test(m[1])) out.push({ file: f, name: m[1], index: m.index, src: s });
    }
  });
  return out;
}

test('PS-1 公開的全域函式只有入口與 api*（其餘一律底線結尾，google.script.run 叫不到）', function () {
  const bad = publicFunctions().filter(function (p) {
    return ALLOWED_PUBLIC.indexOf(p.name) === -1 && !/^api[A-Z]/.test(p.name);
  }).map(function (p) { return p.file + '：' + p.name; });
  assert.deepStrictEqual(bad, []);
});

test('PS-2 每一個 api* 都經 withApiResult_()（先核對權限與只看名單），已停用的除外', function () {
  const bad = [];
  publicFunctions().filter(function (p) { return /^api[A-Z]/.test(p.name); }).forEach(function (p) {
    const end = p.src.indexOf('\n}\n', p.index);
    const body = p.src.slice(p.index, end);
    if (RETIRED_API.indexOf(p.name) !== -1) {
      if (body.indexOf('speakerFormRetiredApiResult_(') === -1) bad.push(p.name + '（已停用但不是回固定錯誤）');
      return;
    }
    if (body.indexOf('withApiResult_(') === -1) bad.push(p.name);
    const m = /functionName:\s*'([A-Za-z]+)'/.exec(body);
    if (!m || m[1] !== p.name) bad.push(p.name + '（functionName 不一致：' + (m ? m[1] : '沒有') + '）');
  });
  assert.deepStrictEqual(bad, []);
});

test('PS-3 以前公開的五個函式已經不存在（改名為底線結尾）', function () {
  const all = files.map(function (f) { return fs.readFileSync(path.join(SRC, f), 'utf8'); }).join('\n');
  ['readSheet', 'writeSheet', 'getConfig', 'setConfig', 'initializeAllSheets'].forEach(function (n) {
    assert.ok(!new RegExp('^function ' + n + '\\s*\\(', 'm').test(all), n + ' 仍然公開');
  });
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
