#!/usr/bin/env node
/**
 * tests/audit-repro/blank-row-rowno.repro.js
 *
 * 獨立審查 2026-11（docs/獨立審查_2026-11.md 發現 A-01）的重現測試。**刻意不納入現有測試清單**：
 * 修好之前這個檔案會失敗（離開碼 1），修好之後才會通過。
 *
 * 問題：`readSheet_()` 會略過整行空白的列（src/SheetUtils.gs），但下面三處用 `index + 3` 當作真正的行號：
 *   - src/Retention.gs `setQuarterArchivedFlag_()`（封存／取消封存，選單「封存指定季度…」、星期一自動封存）
 *   - src/RosterBackfill.gs `backfillRosterForQuarter_()`（補抓空白的事奉欄位）
 *   - src/Bootstrap.gs 補寫 PublishLog 內容指紋（初始化工作表）
 * BulletinWeeks 中間只要有一行整行空白，之後每一行都寫到上一行去。
 *
 * 執行方式：node tests/audit-repro/blank-row-rowno.repro.js
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

const Q = contentEnv.QUARTER_ID;           // 2027T4
const DATES = contentEnv.SERVICE_DATES;    // 五個 2027T4 主日

/** 第 3 行是上一季的一個主日，第 4 行整行空白，第 5 行起是 2027T4。 */
function weekRowsWithBlank() {
  return [{ SERVICE_DATE: '2027-09-26', QUARTER_ID: '2027T3', WEEK_OF_MONTH: 4, STATUS: 'DRAFT' }, {}]
    .concat(DATES.map(function (iso, i) {
      return { SERVICE_DATE: iso, QUARTER_ID: Q, WEEK_OF_MONTH: (i % 4) + 1, STATUS: 'DRAFT' };
    }));
}

function cell(env, rowNo, key) {
  const keys = env.sandbox.COLUMNS.BULLETIN_WEEKS.keys;
  return env.sheets.BulletinWeeks.getRange(rowNo, keys.indexOf(key) + 1, 1, 1).getValue();
}

console.log('\nA-01：中間有一行空白時，用 index + 3 推算行號會寫錯行');

test('選單「封存指定季度…」封存 2027T4：五個主日全部封存，空白行與上一季那一行不動', function () {
  const env = contentEnv.makeEnv({ weekRows: weekRowsWithBlank(), uiText: Q });
  env.sandbox.menuArchiveQuarter_();
  const archived = [3, 4, 5, 6, 7, 8, 9].map(function (r) { return cell(env, r, 'ARCHIVED'); });
  assert.deepStrictEqual(archived.map(function (v) { return v === true; }),
    [false, false, true, true, true, true, true],
    '第 3 至 9 行的 ARCHIVED：' + JSON.stringify(archived) + '（第 4 行是空白行；第 5 至 9 行是 2027T4）');
});

test('補抓空白的事奉欄位（apiBackfillRoster）：ROSTER_STATUS 寫在 2027T4 的五行，不寫空白行', function () {
  const env = contentEnv.makeEnv({ weekRows: weekRowsWithBlank() });
  const resp = env.sandbox.apiBackfillRoster(Q);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  assert.strictEqual(cell(env, 4, 'ROSTER_STATUS'), '', '空白行（第 4 行）不可以被寫入：' + JSON.stringify(cell(env, 4, 'ROSTER_STATUS')));
  assert.notStrictEqual(cell(env, 9, 'ROSTER_STATUS'), '', '最後一個主日（第 9 行）要寫入狀態');
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
