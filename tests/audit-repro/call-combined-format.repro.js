#!/usr/bin/env node
/**
 * tests/audit-repro/call-combined-format.repro.js
 *
 * 獨立審查 2026-11（docs/獨立審查_2026-11.md 發現 A-03）的重現測試。**刻意不納入現有測試清單**：
 * 修好之前這個檔案會失敗（離開碼 1）。
 *
 * 問題：Config `CALL_TO_WORSHIP_FORMAT` 的種子值是 '{{text}}（{{ref}}）'（src/Constants.gs DEFAULTS；程序表
 * src/ProgramTable.gs 用 {{text}}／{{ref}}），但 Word 的 `{{CALL_COMBINED}}`（src/BulletinRender.gs buildCallCombined_()，
 * generateBulletinDocx_() 由同一個 Config 鍵取格式）只認 {{CALL_TEXT}}／{{CALL_REF}}。經文與出處都有時，
 * 範本用了 {{CALL_COMBINED}} 的話，Word 印出的是字面上的「{{text}}（{{ref}}）」。
 *
 * ⚠️ 這一條只經內部函式 buildCallCombined_()（取格式的寫法與 generateBulletinDocx_() 一樣：getConfig_ 該鍵）；
 *    經 generateBulletinDocx_() 要真的 Word 範本，現有工具組不到。
 *
 * 執行方式：node tests/audit-repro/call-combined-format.repro.js
 */

'use strict';

const assert = require('assert');
const contentEnv = require('../helpers/contentEnv');

let fail = 0;
try {
  const sb = contentEnv.makeEnv({}).sandbox;   // Config 用 DEFAULTS 的種子值
  const format = sb.getConfig_(sb.CONFIG_KEYS.CALL_TO_WORSHIP_FORMAT, '{{CALL_TEXT}}（{{CALL_REF}}）');
  const out = sb.buildCallCombined_('你們要讚美耶和華', '詩篇 150:1', format);
  assert.strictEqual(out, '你們要讚美耶和華（詩篇 150:1）', '種子格式「' + format + '」之下 CALL_COMBINED 是「' + out + '」');
  console.log('  ✓ A-03 CALL_COMBINED 用種子格式合成正確');
} catch (err) {
  fail++;
  console.log('  ✗ A-03 ' + err.message.split('\n')[0]);
}
process.exit(fail === 0 ? 0 : 1);
