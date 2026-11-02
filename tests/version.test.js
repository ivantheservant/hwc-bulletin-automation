#!/usr/bin/env node
/**
 * tests/version.test.js
 *
 * 2026-11-03（多堂會／其他教會：方便日後支援和更新）：
 *   - APP_VERSION 是 yyyy.MM.dd（或 yyyy.MM.dd-n），而且 docs/更新說明.md 最上面一段是同一個版本號；
 *   - 設定差異檢查（buildConfigDiffReport_）：缺少、不認識、與預設值不同、設定匯出；電郵與 ID 不完整顯示；
 *   - 堂會名稱（CONGREGATION_NAME）：檔名樣式 {{CONGREGATION}}、電郵範本 {{CongregationName}}。
 *
 * 執行方式：node tests/version.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contentEnv = require('./helpers/contentEnv');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); } catch (err) {
    fail++; console.log('  ✗ ' + name); console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n    ') : err));
  }
}

console.log('\n版本號、設定差異檢查、堂會名稱');

test('V-1 APP_VERSION 的格式；docs/更新說明.md 最上面一段是同一個版本號', function () {
  const sb = contentEnv.makeEnv({}).sandbox;
  assert.ok(/^\d{4}\.\d{2}\.\d{2}(-\d+)?$/.test(sb.APP_VERSION), sb.APP_VERSION);
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', '更新說明.md'), 'utf8');
  const first = (doc.match(/^## (\S+)/m) || [])[1];
  assert.strictEqual(first, sb.APP_VERSION, '更新說明最上面一段要是現在的版本號');
});

test('V-2 設定差異檢查：缺少、不認識、與預設值不同、匯出；電郵只講幾個、ID 只顯示頭 6 個字', function () {
  const sb = contentEnv.makeEnv({}).sandbox;
  const defaults = [
    { key: 'A_NAME', value: '粵語堂' }, { key: 'B_FOLDER_ID', value: '' }, { key: 'C_EMAILS', value: '' }, { key: 'D_MISSING', value: 'x' }
  ];
  const rows = [
    { KEY: 'A_NAME', VALUE: '英語堂' }, { KEY: 'B_FOLDER_ID', VALUE: '1AbCdEfGhIjKlMnOpQrStUv' },
    { KEY: 'C_EMAILS', VALUE: 'a@x.org, b@x.org' }, { KEY: 'OLD_KEY', VALUE: 'y' },
    { KEY: 'TEMPLATE_FILE_ID_NORMAL', VALUE: '1CaOXqCmkvz8NSjAzBmDSlJaRU5dBIkN4' },
    { KEY: 'WEBAPP_URL', VALUE: 'https://script.google.com/a/macros/x.org/s/AKfycbwSECRETSECRETSECRET/exec' }
  ];
  const r = sb.buildConfigDiffReport_(rows, defaults, { version: '2026.11.03', congregation: '英語堂', generatedAt: 'now' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.missing)), ['D_MISSING']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.unknown)), ['OLD_KEY', 'TEMPLATE_FILE_ID_NORMAL', 'WEBAPP_URL']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.differs)), ['A_NAME', 'B_FOLDER_ID', 'C_EMAILS']);
  const text = r.lines.join('\n');
  ['系統版本：2026.11.03　堂會：英語堂', 'A_NAME：現在「英語堂」，預設「粵語堂」', 'B_FOLDER_ID＝1AbCdE…（ID）', 'C_EMAILS＝（已填 2 個電郵）',
    '【缺少的設定（1 個）】', 'OLD_KEY＝y'].forEach(function (p) { assert.ok(text.indexOf(p) !== -1, '缺少：' + p + '\n' + text); });
  assert.strictEqual(text.indexOf('a@x.org'), -1, '電郵不可以出現在報告');
  assert.strictEqual(text.indexOf('1AbCdEfGhIjKlMnOpQrStUv'), -1, '完整 ID 不可以出現在報告');
  assert.strictEqual(text.indexOf('1CaOXqCmkvz8NSjAzBmDSlJaRU5dBIkN4'), -1, '鍵名中間有 _ID 亦要遮蔽');
  assert.ok(text.indexOf('TEMPLATE_FILE_ID_NORMAL＝1CaOXq…（ID）') !== -1, text);
  assert.strictEqual(text.indexOf('AKfycbwSECRET'), -1, '網址只顯示網域');
  assert.ok(text.indexOf('WEBAPP_URL＝script.google.com/…（網址）') !== -1, text);
});

test('V-3 堂會名稱：Config 改了，Word 檔名的 {{CONGREGATION}}、電郵範本的 {{CongregationName}}、填寫介面頁底跟着變；舊的字面檔名樣式照舊', function () {
  const env = contentEnv.makeEnv({ config: { CONGREGATION_NAME: '英語堂', OUTPUT_FILE_NAME_PATTERN: '{{SERVICE_DATE}}_{{CONGREGATION}}週報.docx' } });
  const sb = env.sandbox;
  assert.strictEqual(sb.congregationName_(), '英語堂');
  assert.strictEqual(sb.applyCongregationToken_('{{CONGREGATION}}週報（最新一期）.pdf'), '英語堂週報（最新一期）.pdf');
  assert.strictEqual(sb.applyCongregationToken_('{{SERVICE_DATE}}_粵語堂週報.docx'), '{{SERVICE_DATE}}_粵語堂週報.docx', '舊的字面值不變');
  const vars = sb.buildSendNoticeVars_({ churchName: '聖道堂', isoDate: '2027-10-03' });
  assert.strictEqual(vars.CongregationName, '英語堂');
  const warnings = [];
  assert.strictEqual(sb.renderEmailTemplate_('{{ChurchName}}{{CongregationName}}週報', vars, warnings), '聖道堂英語堂週報');
  assert.strictEqual(warnings.length, 0, '{{CongregationName}} 是已知佔位符');
  const boot = sb.apiBootstrap(false, {});
  assert.strictEqual(boot.data.congregationName, '英語堂');
  assert.strictEqual(boot.data.systemVersion, sb.APP_VERSION);
  const blank = contentEnv.makeEnv({ config: { CONGREGATION_NAME: '' } }).sandbox;
  assert.strictEqual(blank.congregationName_(), '粵語堂', '空白用預設');
});

test('V-4 新部署的電郵範本種子不再寫死「粵語堂」（用 {{CongregationName}}）', function () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Bootstrap.gs'), 'utf8');
  assert.strictEqual(src.indexOf('{{ChurchName}}粵語堂'), -1);
  assert.strictEqual(src.indexOf("'粵語堂週報系統　敬上'"), -1);
  assert.ok(src.indexOf('{{CongregationName}}') !== -1);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
