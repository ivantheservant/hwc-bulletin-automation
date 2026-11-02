#!/usr/bin/env node
/**
 * tests/listorigin.test.js
 *
 * 2026-11-03（交接待辦）：「連續到」帶入的家事報告、代禱事項，填寫介面要看得出來源。
 *   - Announcements／Prayers 最後加「內容表主日日期」「內容表連續到」（ORIGIN_DATE／ORIGIN_UNTIL，純文字），匯入時寫；
 *   - apiLoadWeek 的清單每一則帶 `originNote`（由哪一日起、連續到哪一日、本季還是上一季的內容表）；
 *   - 部署之前匯入的舊行未有來源：只補寫，不算「修改」（plan.backfilled），自動匯入照樣寫、不講「已更新」。
 *
 * 真正入口：apiRunQuarterContentImport、previewContentImport_、apiLoadWeek、apiAutoImportWeek。
 *
 * 執行方式：node tests/listorigin.test.js
 */

'use strict';

const assert = require('assert');
const contentEnv = require('./helpers/contentEnv');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

const QUARTER_ID = contentEnv.QUARTER_ID;
const DATES = contentEnv.SERVICE_DATES;
const [D1, D2, D3] = DATES;

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
function minus7(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}
function annOf(env, iso) {
  return env.sandbox.readSheet_('Announcements').filter(function (a) {
    return env.sandbox.formatIsoDate_(a.SERVICE_DATE) === iso && a.ACTIVE === true;
  });
}

console.log('\n「連續到」帶入的一則看得出來源（真入口）');

test('LO-1 本季「連續到」：D1 起連續到 D3 → D2、D3 那兩則記下來源；介面 D2 那一則講「由 D1 起，連續到 D3（本季內容表）」，D1 自己那一則不講', function () {
  const env = contentEnv.makeEnv({
    content: { 家事報告: [{ SERVICE_DATE: D1, REPEAT_UNTIL: D3, SEQ_NO: '10', TEXT: '連續三週', ACTIVE: 'TRUE' }] }
  });
  const imp = env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  assert.strictEqual(imp.data.ok, true, JSON.stringify(imp.data));
  [D1, D2, D3].forEach(function (iso) {
    const rows = annOf(env, iso);
    assert.strictEqual(rows.length, 1, iso);
    assert.strictEqual(String(rows[0].ORIGIN_DATE), D1);
    assert.strictEqual(String(rows[0].ORIGIN_UNTIL), D3);
  });
  const w2 = env.sandbox.apiLoadWeek(D2, { deferImport: true });
  assert.strictEqual(w2.ok, true, JSON.stringify(w2.error));
  const note = w2.data.lists.announcements[0].originNote;
  assert.strictEqual(note, '連續項目：由 ' + D1 + ' 起，連續到 ' + D3 + '（本季內容表）');
  assert.strictEqual(w2.data.lists.announcements[0].ORIGIN_DATE, undefined, '原始欄不送前端');
  assert.strictEqual(env.sandbox.apiLoadWeek(D1, { deferImport: true }).data.lists.announcements[0].originNote, '', '這一期自己的一則不講');
  assertWrittenChinese(assert, '來源說明', [note]);
});

test('LO-2 上一季帶入：講明是上一季的內容表；代禱事項同樣', function () {
  const env = contentEnv.makeEnv({
    otherContentSheets: [{
      quarterId: '2027T3', fileId: 'FILE_PREV',
      content: {
        家事報告: [{ SERVICE_DATE: minus7(D1), REPEAT_UNTIL: D2, ACTIVE: 'TRUE', SEQ_NO: '10', TEXT: '上一季連續' }],
        代禱事項: [{ SERVICE_DATE: minus7(D1), REPEAT_UNTIL: D1, ACTIVE: 'TRUE', SEQ_NO: '10', TEXT: '上一季代禱' }]
      }
    }]
  });
  assert.strictEqual(env.sandbox.apiRunQuarterContentImport(QUARTER_ID).data.ok, true);
  const w = env.sandbox.apiLoadWeek(D2, { deferImport: true }).data;
  const ann = w.lists.announcements.filter(function (a) { return a.TEXT === '上一季連續'; })[0];
  assert.ok(ann, JSON.stringify(w.lists.announcements));
  assert.strictEqual(ann.originNote, '連續項目：由 ' + minus7(D1) + ' 起，連續到 ' + D2 + '（上一季的內容表）');
  const p = env.sandbox.apiLoadWeek(D1, { deferImport: true }).data.lists.prayers.filter(function (x) { return x.TEXT === '上一季代禱'; })[0];
  assert.strictEqual(p.originNote, '連續項目：由 ' + minus7(D1) + ' 起，連續到 ' + D1 + '（上一季的內容表）');
});

test('LO-3 部署之前匯入的舊行（未有來源）：預覽不算修改（只補寫）；匯入照樣寫來源；自動匯入不講「已更新」但回新資料', function () {
  const env = contentEnv.makeEnv({
    announcements: [
      { SERVICE_DATE: D1, SEQ_NO: 10, TEXT: '連續兩週', ACTIVE: true },
      { SERVICE_DATE: D2, SEQ_NO: 10, TEXT: '連續兩週', ACTIVE: true }
    ],
    content: { 家事報告: [{ SERVICE_DATE: D1, REPEAT_UNTIL: D2, SEQ_NO: '10', TEXT: '連續兩週', ACTIVE: 'TRUE' }] }
  });
  const preview = env.sandbox.previewContentImport_(QUARTER_ID, {});
  assert.strictEqual(preview.plan.updated, 0, '只補寫來源不算修改');
  assert.strictEqual(preview.plan.backfilled, 2);
  assert.strictEqual(preview.plan.details.filter(function (d) { return d.field === 'ORIGIN_DATE'; }).length, 0, '明細不列');
  const auto = env.sandbox.apiAutoImportWeek(D2);
  assert.strictEqual(auto.ok, true, JSON.stringify(auto.error));
  assert.strictEqual(auto.data.autoImport.changed, 0, '不講已更新');
  assert.strictEqual(auto.data.autoImport.backfilled, 1);
  assert.ok(auto.data.week, '補寫之後回新資料（介面要顯示來源）');
  assert.strictEqual(auto.data.week.lists.announcements[0].originNote, '連續項目：由 ' + D1 + ' 起，連續到 ' + D2 + '（本季內容表）');
  assert.strictEqual(String(annOf(env, D2)[0].ORIGIN_DATE), D1);
  assert.strictEqual(String(annOf(env, D1)[0].ORIGIN_DATE || ''), '', '只匯入 D2，D1 未補');
  // 再匯入一次：已經補好，沒有東西要寫。
  const again = env.sandbox.previewContentImport_(QUARTER_ID, { isoDate: D2 });
  assert.strictEqual(again.plan.backfilled, 0);
  assert.strictEqual(again.plan.updated, 0);
});

test('LO-4 內容表把「連續到」改了 → 已有來源的行照常算「修改」', function () {
  const env = contentEnv.makeEnv({
    content: { 家事報告: [{ SERVICE_DATE: D1, REPEAT_UNTIL: D3, SEQ_NO: '10', TEXT: '連續', ACTIVE: 'TRUE' }] }
  });
  env.sandbox.apiRunQuarterContentImport(QUARTER_ID);
  const tab = env.contentTabs['家事報告'];
  const r = tab.__data.findIndex(function (row, i) { return i >= 2 && row[0] === D1; });
  tab.__data[r][tab.__data[1].indexOf('REPEAT_UNTIL')] = D2;
  const preview = env.sandbox.previewContentImport_(QUARTER_ID, { isoDate: D1 });
  assert.strictEqual(preview.plan.updated, 1, JSON.stringify(preview.plan.details));
  assert.ok(preview.plan.details.some(function (d) { return d.field === 'ORIGIN_UNTIL' && String(d.newValue) === D2; }));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
