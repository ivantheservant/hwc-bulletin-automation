#!/usr/bin/env node
/**
 * tests/auditfixes.test.js
 *
 * 獨立審查 2026-11（docs/獨立審查_2026-11.md）之後的修正（docs/待確認事項.md「LL」）。
 * 原本 tests/audit-repro/ 的七條重現測試搬入這裏（修好之前會失敗），另加每一項修正經真正入口的測試。
 *
 *   A-01 用 __rowNo 寫行（封存、補抓、PublishLog 補寫指紋）　A-02 DRY_RUN 只有明確 FALSE 才是正式模式
 *   A-03 宣召格式兩套記號都認　A-04 檢查職事表分歧（網頁）真的唯讀　A-05 補抓：讀職事表出錯不當作「未有資料」，經鎖
 *   A-08 儲存的文字經 sanitizeCellText_　C-01 匯入計畫在鎖內重算　C-02 新增行逐個主日寫
 *   （A-03 經 generateBulletinDocx_ 的測試在 tests/bulletinrender.test.js；A-07 在 tests/writeaction.test.js；
 *    C-03 在 tests/v3retest.test.js；C-05 在 tests/contentsheet.test.js。）
 *
 * 執行方式：node tests/auditfixes.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const contentEnv = require('./helpers/contentEnv');
const { makeFillEnv, QUARTER_ID: FILL_QUARTER } = require('./helpers/fillEnv');
const { changedDutyCells, SAVE_PAYLOAD_VERSION } = require('./helpers/savePayload');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); } catch (err) {
    fail++; console.log('  ✗ ' + name); console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n    ') : err));
  }
}
function plain(v) { return JSON.parse(JSON.stringify(v)); }

const Q = contentEnv.QUARTER_ID;           // 2027T4
const DATES = contentEnv.SERVICE_DATES;    // 五個 2027T4 主日

// =====================================================================
console.log('\nA-01：中間有一行空白時，寫入要用真正的行號');
// =====================================================================

/** 第 3 行是上一季的一個主日，第 4 行整行空白，第 5 行起是 2027T4。 */
function weekRowsWithBlank() {
  return [{ SERVICE_DATE: '2027-09-26', QUARTER_ID: '2027T3', WEEK_OF_MONTH: 4, STATUS: 'DRAFT' }, {}]
    .concat(DATES.map(function (iso, i) {
      return { SERVICE_DATE: iso, QUARTER_ID: Q, WEEK_OF_MONTH: (i % 4) + 1, STATUS: 'DRAFT' };
    }));
}
function weekCell(env, rowNo, key) {
  const keys = env.sandbox.COLUMNS.BULLETIN_WEEKS.keys;
  return env.sheets.BulletinWeeks.getRange(rowNo, keys.indexOf(key) + 1, 1, 1).getValue();
}

test('A-01 選單「封存指定季度…」封存 2027T4：五個主日全部封存，空白行與上一季那一行不動；取消封存全部還原', function () {
  const env = contentEnv.makeEnv({ weekRows: weekRowsWithBlank(), uiText: Q });
  env.sandbox.menuArchiveQuarter_();
  const archived = [3, 4, 5, 6, 7, 8, 9].map(function (r) { return weekCell(env, r, 'ARCHIVED') === true; });
  assert.deepStrictEqual(archived, [false, false, true, true, true, true, true], JSON.stringify(archived));
  env.sandbox.menuUnarchiveQuarter_();
  const after = [3, 4, 5, 6, 7, 8, 9].map(function (r) { return weekCell(env, r, 'ARCHIVED') === true; });
  assert.deepStrictEqual(after, [false, false, false, false, false, false, false], JSON.stringify(after));
});

test('A-01 補抓空白的事奉欄位（apiBackfillRoster）：ROSTER_STATUS 寫在 2027T4 的五行，不寫空白行', function () {
  const env = contentEnv.makeEnv({ weekRows: weekRowsWithBlank() });
  const resp = env.sandbox.apiBackfillRoster(Q);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  assert.strictEqual(weekCell(env, 4, 'ROSTER_STATUS'), '', '空白行（第 4 行）不可以被寫入');
  assert.strictEqual(weekCell(env, 3, 'ROSTER_STATUS'), '', '上一季那一行不可以被寫入');
  [5, 6, 7, 8, 9].forEach(function (r) { assert.notStrictEqual(weekCell(env, r, 'ROSTER_STATUS'), '', '第 ' + r + ' 行要寫入狀態'); });
});

test('A-01 初始化工作表補寫 PublishLog 指紋（backfillPublishLogContentFingerprint_）：中間有空白行，指紋寫在原本那一行', function () {
  const env = contentEnv.makeEnv({});
  const sb = env.sandbox;
  const def = sb.COLUMNS.PUBLISH_LOG;
  const sheet = env.sheets.PublishLog;
  function rowOf(obj) { return def.keys.map(function (k) { return obj[k] === undefined ? '' : obj[k]; }); }
  sheet.getRange(3, 1, 3, def.keys.length).setValues([
    rowOf({ PUBLISH_ID: 'P1', SERVICE_DATE: '2027-10-03', VERSION_NO: 1, ARCHIVE_FILE_ID: 'ARCH_1' }),
    rowOf({}),
    rowOf({ PUBLISH_ID: 'P2', SERVICE_DATE: '2027-10-10', VERSION_NO: 1, ARCHIVE_FILE_ID: 'ARCH_2' })
  ]);
  sb.readMasterPdfBytes_ = function (id) { return 'BYTES-' + id; };
  sb.pdfFingerprint_ = function (bytes) { return bytes.length + ':' + (bytes === 'BYTES-ARCH_1' ? 'md5one' : 'md5two'); };
  sb.backfillPublishLogContentFingerprint_();
  const col = def.keys.indexOf('CONTENT_MD5') + 1;
  assert.strictEqual(sheet.getRange(4, col, 1, 1).getValue(), '', '空白行不可以被寫入');
  assert.strictEqual(sheet.getRange(5, col, 1, 1).getValue(), 'md5two', '第二筆發佈的指紋寫在它自己那一行（第 5 行）');
});

// =====================================================================
console.log('\nA-02：DRY_RUN 只有明確 FALSE 才是正式模式');
// =====================================================================

test('A-02 DRY_RUN 空白：星期一草稿預覽信（sendPreviewNotice_）當作試行', function () {
  const env = contentEnv.makeEnv({ config: { DRY_RUN: '' } });
  assert.strictEqual(env.sandbox.sendPreviewNotice_(DATES[0]).dryRun, true);
});

test('A-02 上線前檢查（buildGoLiveChecklist_）：空白、寫錯都報紅燈，不報「正式模式」；TRUE 黃燈；FALSE 綠燈「正式模式」', function () {
  function item(value) {
    const env = contentEnv.makeEnv({ config: { DRY_RUN: value } });
    return env.sandbox.buildGoLiveChecklist_().filter(function (i) { return i.label === '上線前：寄送模式'; })[0];
  }
  const blank = item('');
  assert.strictEqual(blank.status, '🔴', JSON.stringify(blank));
  assert.ok(blank.message.indexOf('正式模式') === -1 && blank.message.indexOf('空白') !== -1, blank.message);
  const bad = item('maybe');
  assert.strictEqual(bad.status, '🔴');
  assert.ok(bad.message.indexOf('maybe') !== -1, bad.message);
  assert.strictEqual(item('TRUE').status, '🟡');
  const real = item('FALSE');
  assert.strictEqual(real.status, '🟢');
  assert.ok(real.message.indexOf('正式模式') !== -1);
});

test('A-02 isDryRun_()：只有 FALSE／否才是 false；TRUE、空白、寫錯、讀不到 Config 都是 true', function () {
  ['FALSE', 'false', ' False ', '否'].forEach(function (v) {
    assert.strictEqual(contentEnv.makeEnv({ config: { DRY_RUN: v } }).sandbox.isDryRun_(), false, JSON.stringify(v));
  });
  ['TRUE', '', '  ', 'maybe', '0'].forEach(function (v) {
    assert.strictEqual(contentEnv.makeEnv({ config: { DRY_RUN: v } }).sandbox.isDryRun_(), true, JSON.stringify(v));
  });
  const sb = contentEnv.makeEnv({}).sandbox;
  sb.loadConfigCache_ = function () { throw new Error('讀不到 Config'); };
  sb.CONFIG_CACHE_ = null;
  assert.strictEqual(sb.isDryRun_(), true);
  assert.strictEqual(sb.dryRunConfigState_().state, 'UNREADABLE');
});

test('A-02 全系統不再自己判斷 DRY_RUN（src 只有 ConfigService.gs 讀這個鍵）', function () {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'src');
  const offenders = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.gs') && f !== 'Constants.gs' && f !== 'ConfigService.gs'; })
    .filter(function (f) { return fs.readFileSync(path.join(dir, f), 'utf8').indexOf('CONFIG_KEYS.DRY_RUN') !== -1; });
  assert.deepStrictEqual(offenders, [], '這些檔案自己讀 DRY_RUN：' + offenders.join('、'));
});

// =====================================================================
console.log('\nA-03：宣召格式兩套記號都認');
// =====================================================================

test('A-03 種子格式「{{text}}（{{ref}}）」：CALL_COMBINED 與程序表都合成正確；舊記號 {{CALL_TEXT}} 亦照樣認', function () {
  const sb = contentEnv.makeEnv({}).sandbox;
  const format = sb.getConfig_(sb.CONFIG_KEYS.CALL_TO_WORSHIP_FORMAT, '');
  assert.strictEqual(format, '{{text}}（{{ref}}）', '前提：Config 用種子值');
  assert.strictEqual(sb.buildCallCombined_('你們要讚美耶和華', '詩篇 150:1', format), '你們要讚美耶和華（詩篇 150:1）');
  assert.strictEqual(sb.formatCallToWorship_('你們要讚美耶和華', '詩篇 150:1', format), '你們要讚美耶和華（詩篇 150:1）');
  assert.strictEqual(sb.buildCallCombined_('甲', '乙', '{{CALL_TEXT}}——{{CALL_REF}}'), '甲——乙');
  assert.strictEqual(sb.formatCallToWorship_('甲', '乙', '{{CALL_TEXT}}——{{CALL_REF}}'), '甲——乙');
  assert.strictEqual(sb.buildCallCombined_('', '詩篇 1', format), '詩篇 1', '只有出處：照舊只顯示出處');
  assert.strictEqual(sb.formatCallToWorship_('', '詩篇 1', format), '（詩篇 1）', '程序表只有出處：照舊（行為不變）');
});

// =====================================================================
console.log('\nA-04：檢查職事表分歧（網頁）真的唯讀');
// =====================================================================

test('A-04 apiRosterDiffReport（只可以看的用戶亦叫得到）：不寫 AuditLog、不寫 BulletinWeeks；選單「檢查職事表分歧」照舊記下快照版本，而且經指令碼鎖', function () {
  const env = contentEnv.makeEnv({ config: { WEBAPP_ALLOWED_EMAILS: 'editor@x.com', WEBAPP_VIEWER_EMAILS: 'tester@x.com' }, uiText: DATES[0] });
  const sb = env.sandbox;
  const resp = sb.apiRosterDiffReport(DATES[0]);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  assert.strictEqual(sb.readSheet_('AuditLog').length, 0, '報告不寫 AuditLog');
  const w = env.sheets.BulletinWeeks.__calls;
  assert.strictEqual(w.setValue + w.setValues, 0, '報告不寫 BulletinWeeks');
  assert.strictEqual(weekCell(env, 3, 'ROSTER_SNAPSHOT_VERSION'), '');

  const before = env.locks.tried;
  sb.menuCheckRosterDiff_();
  assert.notStrictEqual(String(weekCell(env, 3, 'ROSTER_SNAPSHOT_VERSION')), '', '選單照舊記下快照版本');
  assert.strictEqual(env.locks.tried, before + 1, '選單的寫入經指令碼鎖');
});

// =====================================================================
console.log('\nA-05：補抓——讀職事表出錯不當作「未有資料」');
// =====================================================================

test('A-05 apiBackfillRoster：開職事表失敗 → ok:false、講原因、一格都不寫（職事表狀態不變）；經指令碼鎖', function () {
  const env = contentEnv.makeEnv({});
  const sb = env.sandbox;
  const realOpen = sb.SpreadsheetApp.openById;
  sb.SpreadsheetApp.openById = function (id) {
    if (id === contentEnv.FAKE_ROSTER_ID) throw new Error('You do not have permission to access the requested document.');
    return realOpen.apply(this, arguments);
  };
  const before = env.locks.tried;
  const resp = sb.apiBackfillRoster(Q);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  assert.strictEqual(resp.data.ok, false, JSON.stringify(resp.data));
  assert.strictEqual(resp.data.reason, 'ROSTER_READ_ERROR');
  assert.ok(resp.data.message.indexOf('讀不到職事表') !== -1 && resp.data.message.indexOf('permission') !== -1, resp.data.message);
  assert.ok(resp.data.message.indexOf('未有季度') === -1, '不可以講成「職事表未有資料」');
  [3, 4, 5, 6, 7].forEach(function (r) { assert.strictEqual(weekCell(env, r, 'ROSTER_STATUS'), '', '第 ' + r + ' 行不可以被寫成 NOT_FOUND'); });
  assert.strictEqual(env.locks.tried, before + 1, '補抓經指令碼鎖');
});

test('A-05 apiBackfillRoster：拿不到鎖 → LOCK_TIMEOUT，一格都不寫', function () {
  const env = contentEnv.makeEnv({ lockFails: true });
  const resp = env.sandbox.apiBackfillRoster(Q);
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'LOCK_TIMEOUT');
  assert.strictEqual(weekCell(env, 3, 'ROSTER_STATUS'), '');
});

// =====================================================================
console.log('\nA-08：儲存的文字經 sanitizeCellText_（與內容表匯入同一做法）');
// =====================================================================

const W = '2027-11-14';
function makeSaveEnv() {
  const env = makeFillEnv({
    withGrid: false,
    weekRows: ['2027-11-07', W, '2027-11-21'].map(function (iso, i) {
      return { SERVICE_DATE: iso, QUARTER_ID: FILL_QUARTER, WEEK_OF_MONTH: i + 1, STATUS: 'DRAFT', LAST_SAVED_AT: '2026-10-01' };
    }),
    config: { PRELUDE_DEFAULT: '預設序樂' }
  });
  return env;
}
function saveWeek(sb, patch, duty) {
  const tab = plain(sb.loadWeekForWebApp_(W));
  return sb.apiSaveWeek(plain({
    isoDate: W, lastSavedAt: tab.lastSavedAt, payloadVersion: SAVE_PAYLOAD_VERSION, week: patch,
    baseWeek: plain(sb.baseWeekFor_(tab.week, patch)),
    dutyEdits: changedDutyCells(tab.readOnly.dutyBoxPage1, duty || {}), nextWeekDutyEdits: []
  }));
}

test('A-08 apiSaveWeek：以 = + - @ 開頭的文字先加前導單引號才寫（不會被當成公式）；讀回、畫面上的值不變', function () {
  const env = makeSaveEnv();
  const sb = env.sandbox;
  const resp = saveWeek(sb, { PRELUDE: '=1+1', CALL_TEXT: '-你們要讚美', HYMN_PRAISE: '+一首' });
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  const escaped = env.sheets.BulletinWeeks.__escapedValues;
  ['=1+1', '-你們要讚美', '+一首'].forEach(function (v) { assert.ok(escaped.has(v), v + ' 要經 sanitizeCellText_()'); });
  const tab = plain(sb.loadWeekForWebApp_(W));
  assert.strictEqual(tab.week.PRELUDE, '=1+1', '讀回的值不變（前導單引號只是格式標記）');
  assert.strictEqual(tab.week.CALL_TEXT, '-你們要讚美');
  // 再存一次同樣的值：三方比對當作沒有改動（顯示與比對都不受影響）。
  const again = saveWeek(sb, { PRELUDE: '=1+1' });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.data.changedFieldCount, 0, '同一個值不會被當成改動');
});

test('A-08 apiSaveWeek：事奉框覆寫改名（更新現有一行）亦經 sanitizeCellText_', function () {
  const env = makeSaveEnv();
  const sb = env.sandbox;
  assert.strictEqual(saveWeek(sb, {}, { 'CHAIR#1': '李小明' }).ok, true);
  const second = saveWeek(sb, {}, { 'CHAIR#1': '-李小明' });
  assert.strictEqual(second.ok, true, JSON.stringify(second.error));
  assert.ok(env.sheets.DutyOverride.__escapedValues.has('-李小明'), '更新那一格要經 sanitizeCellText_()');
});

// =====================================================================
console.log('\nC-01、C-02：內容表匯入');
// =====================================================================

function makeImportEnv(extra) {
  return contentEnv.makeEnv(Object.assign({
    config: { WEBAPP_SIMULATED_TODAY: '2027-10-01' },
    content: {
      家事報告: DATES.map(function (d) { return { SERVICE_DATE: d, SEQ_NO: '10', TEXT: '家事 ' + d, ACTIVE: 'TRUE' }; }),
      崇拜程序: DATES.map(function (d) { return { SERVICE_DATE: d, SERMON_TITLE: '講題 ' + d, ACTIVE: 'TRUE' }; })
    }
  }, extra || {}));
}

test('C-01 鎖外算好的計畫：另一個匯入先寫完，拿到鎖之後重算——家事報告不重複', function () {
  const env = makeImportEnv();
  const sb = env.sandbox;
  const earlier = sb.previewContentImport_(Q, {});           // 例如自動匯入（autoImportContentForWeek_）先預覽
  assert.strictEqual(earlier.plan.added, DATES.length, '前提：預覽時要新增五行');
  sb.applyContentImport_(Q, {});                             // 另一個匯入在這中間寫完
  const applied = sb.applyContentImport_(Q, { precomputedPreview: earlier }); // 拿到鎖之後照用舊計畫
  const active = sb.readSheet_('Announcements').filter(function (r) { return r.ACTIVE === true; });
  assert.strictEqual(active.length, DATES.length, '生效中的家事報告 ' + active.length + ' 行');
  assert.strictEqual(applied.plan.added, 0, '回傳的是鎖內重算的計畫');
});

test('C-01 apiAutoImportWeek（真入口，預覽在鎖外）：預覽之後、寫入之前有人匯入了同一週 → 不重複', function () {
  const env = makeImportEnv();
  const sb = env.sandbox;
  const props = {};
  sb.PropertiesService = { getScriptProperties: function () {
    return { getProperty: function (k) { return props[k] === undefined ? null : props[k]; }, setProperty: function (k, v) { props[k] = String(v); }, deleteProperty: function (k) { delete props[k]; } };
  } };
  sb.readContentSheetLastUpdatedMillis_ = function () { return 1000; };
  const realPreview = sb.previewContentImport_;
  let raced = false;
  sb.previewContentImport_ = function () {
    const out = realPreview.apply(this, arguments);
    if (!raced) { raced = true; sb.applyContentImport_(Q, { isoDate: DATES[0] }); }  // 另一個執行在預覽之後搶先寫了
    return out;
  };
  const resp = sb.apiAutoImportWeek(DATES[0]);
  assert.strictEqual(resp.ok, true, JSON.stringify(resp.error));
  const rows = sb.readSheet_('Announcements').filter(function (r) { return r.ACTIVE === true && sb.formatIsoDate_(sb.normalizeDate_(r.SERVICE_DATE)) === DATES[0]; });
  assert.strictEqual(rows.length, 1, DATES[0] + ' 的家事報告 ' + rows.length + ' 行');
});

test('C-02 apiRunQuarterContentImport：第三個主日寫 BulletinWeeks 時拋錯；已寫好講題的主日，家事報告亦已寫入；AuditLog 記了已做的', function () {
  const env = makeImportEnv();
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
  assert.deepStrictEqual(loggedDates, [DATES[0], DATES[1]]);
  const announced = sb.readSheet_('Announcements').map(function (r) { return sb.formatIsoDate_(sb.normalizeDate_(r.SERVICE_DATE)); });
  loggedDates.forEach(function (d) { assert.ok(announced.indexOf(d) !== -1, d + ' 的家事報告要已經寫入：' + JSON.stringify(announced)); });
  const appendLogged = sb.readSheet_('AuditLog').filter(function (r) { return r.SHEET_NAME === 'Announcements'; }).map(function (r) { return String(r.ROW_KEY); });
  assert.ok(appendLogged.indexOf(DATES[0]) !== -1, '已寫的新增行有 AuditLog');
  // 再匯入一次：補回其餘主日，結果與一次做完相同、沒有重複。
  sb.setRowCellsTextSafe_ = real;
  assert.strictEqual(sb.apiRunQuarterContentImport(Q).ok, true);
  assert.strictEqual(sb.readSheet_('Announcements').filter(function (r) { return r.ACTIVE === true; }).length, DATES.length);
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
