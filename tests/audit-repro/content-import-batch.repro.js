#!/usr/bin/env node
/**
 * tests/audit-repro/content-import-batch.repro.js
 *
 * 獨立審查 2026-11（docs/獨立審查_2026-11.md 發現 C-01、C-02）的重現測試。**刻意不納入現有測試清單**：
 * 修好之前這個檔案會失敗（離開碼 1）。
 *
 * C-01：匯入計畫在指令碼鎖之外算好（`applyContentImport_()` 先預覽、或者用呼叫方給的 `precomputedPreview`），
 *       拿到鎖之後照用，不重算。另一個匯入（自動同步、另一個帳戶的觸發器、幹事按「請再按一次繼續」）在這中間寫完的話，
 *       新增的清單行會再加一次。b13e787 把新增行移到整次匯入最後才寫，令這個窗口由幾秒變成最長 240 秒。
 * C-02：b13e787 之後新增的清單行在主日迴圈之後才寫、AuditLog 最後才一次寫；中途拋錯時，已經「做完」的主日沒有新增行
 *       （以前是先寫清單表，每格即時記 AuditLog）。KK-11 說「不會留下寫了一半的主日」在出錯時不成立。
 *
 * 執行方式：node tests/audit-repro/content-import-batch.repro.js
 */

'use strict';

const assert = require('assert');
const contentEnv = require('../helpers/contentEnv');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); } catch (err) {
    fail++; console.log('  ✗ ' + name); console.log('    ' + (err && err.message ? err.message.split('\n').slice(0, 3).join('\n    ') : err));
  }
}

const Q = contentEnv.QUARTER_ID;
const DATES = contentEnv.SERVICE_DATES;

function makeEnv() {
  return contentEnv.makeEnv({
    config: { WEBAPP_SIMULATED_TODAY: '2027-10-01' },
    content: {
      家事報告: DATES.map(function (d) { return { SERVICE_DATE: d, SEQ_NO: '10', TEXT: '家事 ' + d, ACTIVE: 'TRUE' }; }),
      崇拜程序: DATES.map(function (d) { return { SERVICE_DATE: d, SERMON_TITLE: '講題 ' + d, ACTIVE: 'TRUE' }; })
    }
  });
}

console.log('\nC-01：鎖外算好的計畫在鎖內照用');

test('另一個匯入先寫完，再用鎖外算好的計畫寫：家事報告不可以重複', function () {
  const env = makeEnv();
  const sb = env.sandbox;
  const earlier = sb.previewContentImport_(Q, {});           // 例如自動匯入（autoImportContentForWeek_）先預覽
  sb.applyContentImport_(Q, {});                             // 另一個匯入在這中間寫完
  sb.applyContentImport_(Q, { precomputedPreview: earlier }); // 拿到鎖之後照用舊計畫
  const active = sb.readSheet_('Announcements').filter(function (r) { return r.ACTIVE === true; });
  assert.strictEqual(active.length, DATES.length, '生效中的家事報告 ' + active.length + ' 行（應該是 ' + DATES.length + ' 行）');
});

console.log('\nC-02：中途拋錯時，已經做完的主日缺了新增行');

test('apiRunQuarterContentImport：第三個主日寫 BulletinWeeks 時拋錯；AuditLog 記了講題的主日，家事報告亦要已經寫入', function () {
  const env = makeEnv();
  const sb = env.sandbox;
  const real = sb.setRowCellsTextSafe_;
  let calls = 0;
  sb.setRowCellsTextSafe_ = function () {
    calls++;
    if (calls === 3) throw new Error('Service Spreadsheets timed out');
    return real.apply(this, arguments);
  };
  const resp = sb.apiRunQuarterContentImport(Q);
  assert.strictEqual(resp.ok, false, '前提：這一次匯入失敗');
  const loggedDates = Array.from(new Set(sb.readSheet_('AuditLog')
    .filter(function (r) { return r.ACTION === 'CONTENT_SHEET_IMPORT' && r.SHEET_NAME === 'BulletinWeeks'; })
    .map(function (r) { return String(r.ROW_KEY); }))).sort();
  assert.ok(loggedDates.length > 0, '前提：有主日已經寫好');
  const announced = sb.readSheet_('Announcements').map(function (r) { return sb.formatIsoDate_(sb.normalizeDate_(r.SERVICE_DATE)); });
  loggedDates.forEach(function (d) {
    assert.ok(announced.indexOf(d) !== -1, d + ' 的講題已寫入，家事報告卻沒有（Announcements 有：' + JSON.stringify(announced) + '）');
  });
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
