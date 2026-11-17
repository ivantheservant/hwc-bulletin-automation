#!/usr/bin/env node
/**
 * tests/audit-repro/dryrun-blank.repro.js
 *
 * 獨立審查 2026-11（docs/獨立審查_2026-11.md 發現 A-02）的重現測試。**刻意不納入現有測試清單**：
 * 修好之前這個檔案會失敗（離開碼 1）。
 *
 * 問題：Config 有 DRY_RUN 這一行、但值是空白時，`getConfig_(DRY_RUN, 'TRUE')` 回 ''（鍵存在就不用預設值），
 * `normalizeBoolean_('')` 回 null，`null === true` 是 false——全系統十多處寫法相同，於是當作「正式模式」真的寄出；
 * 「上線前檢查」還報 🟢「正式模式」。
 *
 * 執行方式：node tests/audit-repro/dryrun-blank.repro.js
 */

'use strict';

const assert = require('assert');
const contentEnv = require('../helpers/contentEnv');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); } catch (err) {
    fail++; console.log('  ✗ ' + name); console.log('    ' + (err && err.message ? err.message.split('\n').slice(0, 4).join('\n    ') : err));
  }
}

console.log('\nA-02：DRY_RUN 留空');

test('星期一草稿預覽信（sendPreviewNotice_，星期一觸發器叫的同一支）：DRY_RUN 空白要當作試行', function () {
  const env = contentEnv.makeEnv({ config: { DRY_RUN: '' } });
  const out = env.sandbox.sendPreviewNotice_(contentEnv.SERVICE_DATES[0]);
  assert.strictEqual(out.dryRun, true, 'DRY_RUN 空白時 dryRun 是 ' + JSON.stringify(out.dryRun) + '（＝會真的寄出）');
});

test('上線前檢查（buildGoLiveChecklist_）：DRY_RUN 空白不可以報綠燈「正式模式」', function () {
  const env = contentEnv.makeEnv({ config: { DRY_RUN: '' } });
  const item = env.sandbox.buildGoLiveChecklist_().filter(function (i) { return i.label === '上線前：寄送模式'; })[0];
  assert.ok(item, '找不到「寄送模式」一項');
  assert.ok(String(item.message).indexOf('正式模式') === -1, '報的是：' + item.message);
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
