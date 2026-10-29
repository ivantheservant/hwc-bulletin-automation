#!/usr/bin/env node
/**
 * tests/postdemo1030.test.js
 *
 * 2026-10-30（示範之後，Ivan 的決定）第一批：
 *   - 獻花一行 {{FLOWER_LINE}}：沒有名字的那一半不印，兩週都沒有就整行不印（範本用 {{#IFP:FLOWER_LINE}}）。
 *   - 內容表「次序」留空：排在有次序的後面（以前當 0，排最前）。
 *   - 內容表自動同步（src/ContentAutoSync.gs）：內容表有改動就每 N 分鐘匯入今日及之後的主日。
 *
 *   ⚠️ bug class 5：每一項都由真正入口叫一次——`generateBulletinDocx_`、`applyContentImport_`、
 *   `contentAutoSyncTrigger_`（時間觸發器的入口）。
 *
 * 執行方式：node tests/postdemo1030.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { makeWordEnv } = require('./helpers/wordEnv');
const { buildFakeDocx } = require('./helpers/fakeDrive');
const fx = require('./fixtures/docxXml');
const contentEnv = require('./helpers/contentEnv');

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

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function documentXmlOf(blob) {
  const hit = blob.__entries.filter(function (e) { return e.getName() === 'word/document.xml'; });
  assert.strictEqual(hit.length, 1);
  return hit[0].__text;
}
function visibleText(xml) {
  const out = [];
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = pattern.exec(xml)) !== null) out.push(m[1]);
  return out.join('');
}

// =====================================================================
console.log('\n獻花一行 {{FLOWER_LINE}}');
// =====================================================================

test('buildFlowerLine_：兩週都有／只有本週／只有下週／兩週都沒有；字眼可以由 Config 改', function () {
  const sb = makeWordEnv({}).sandbox;
  assert.strictEqual(sb.buildFlowerLine_({ thisWeek: '假甲', nextWeek: '假乙' }), '本週主日獻花：假甲  下週主日獻花：假乙');
  assert.strictEqual(sb.buildFlowerLine_({ thisWeek: '假甲', nextWeek: '' }), '本週主日獻花：假甲');
  assert.strictEqual(sb.buildFlowerLine_({ thisWeek: ' ', nextWeek: '假乙' }), '下週主日獻花：假乙');
  assert.strictEqual(sb.buildFlowerLine_({ thisWeek: '', nextWeek: '' }), '');
  assert.strictEqual(sb.buildFlowerLine_({ thisWeek: '甲', nextWeek: '乙' }, { thisWeekLabel: '今週：', nextWeekLabel: '下週：', separator: '／' }),
    '今週：甲／下週：乙');
});

function flowerTemplate() {
  return buildFakeDocx(fx.documentXml(
    fx.para(fx.run('{{SERMON_TITLE}}')) + fx.para(fx.run('{{#IFP:FLOWER_LINE}}{{FLOWER_LINE}}'))
  ));
}

test('generateBulletinDocx_（真正入口）：下週沒有獻花 → 不印「下週主日獻花：」；兩週都沒有 → 整行不印', function () {
  const D = '2027-11-07';
  const D_NEXT = '2027-11-14';
  const onlyThis = makeWordEnv({
    driveOptions: { files: { FAKE_TEMPLATE_ID_NORMAL: flowerTemplate() } },
    weekRows: [
      { SERVICE_DATE: D, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT', SERMON_TITLE: '講題一', FLOWER_THIS_WEEK: '假甲', FLOWER_NEXT_WEEK: '' },
      { SERVICE_DATE: D_NEXT, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 2, STATUS: 'DRAFT', SERMON_TITLE: '講題二' }
    ]
  });
  const r1 = onlyThis.sandbox.generateBulletinDocx_(D);
  assert.strictEqual(r1.ok, true, JSON.stringify(r1));
  const t1 = visibleText(documentXmlOf(r1.blob));
  assert.ok(t1.indexOf('本週主日獻花：假甲') !== -1, t1);
  assert.ok(t1.indexOf('下週主日獻花') === -1, t1);

  const none = makeWordEnv({
    driveOptions: { files: { FAKE_TEMPLATE_ID_NORMAL: flowerTemplate() } },
    weekRows: [
      { SERVICE_DATE: D, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT', SERMON_TITLE: '講題一', FLOWER_THIS_WEEK: '', FLOWER_NEXT_WEEK: '' },
      { SERVICE_DATE: D_NEXT, QUARTER_ID: '2027T4', WEEK_OF_MONTH: 2, STATUS: 'DRAFT', SERMON_TITLE: '講題二' }
    ]
  });
  const r2 = none.sandbox.generateBulletinDocx_(D);
  assert.strictEqual(r2.ok, true, JSON.stringify(r2));
  const xml2 = documentXmlOf(r2.blob);
  assert.ok(visibleText(xml2).indexOf('獻花') === -1, visibleText(xml2));
  assert.ok(xml2.indexOf('{{') === -1, '不可以殘留佔位符');
});

// =====================================================================
console.log('\n內容表「次序」留空排在有次序的後面');
// =====================================================================

test('compareContentRowsBySeq_：數字由細到大，留空排後，其餘按行號', function () {
  const sb = makeWordEnv({}).sandbox;
  const rows = [
    { SEQ_NO: '', __rowNo: 3, k: 'C' }, { SEQ_NO: '20', __rowNo: 4, k: 'B' }, { SEQ_NO: 10, __rowNo: 5, k: 'A' },
    { SEQ_NO: '  ', __rowNo: 6, k: 'D' }, { SEQ_NO: 'abc', __rowNo: 7, k: 'E' }
  ];
  assert.deepStrictEqual(rows.slice().sort(sb.compareContentRowsBySeq_).map(function (r) { return r.k; }), ['A', 'B', 'C', 'D', 'E']);
});

test('applyContentImport_（真正入口）：同一主日有填次序與留空 → 匯入週報的次序是「有次序的先、留空的按行的先後」', function () {
  const env = contentEnv.makeEnv({
    content: {
      家事報告: [
        { SERVICE_DATE: '2027-10-03', SEQ_NO: '', TEXT: '丙（留空，先寫）', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-10-03', SEQ_NO: '20', TEXT: '乙', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-10-03', SEQ_NO: '10', TEXT: '甲', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-10-03', SEQ_NO: '', TEXT: '丁（留空，後寫）', ACTIVE: '' }
      ]
    }
  });
  const result = env.sandbox.applyContentImport_(contentEnv.QUARTER_ID, { isoDate: '2027-10-03' });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const rows = env.sandbox.readSheet('Announcements')
    .filter(function (r) { return r.ACTIVE === true; })
    .sort(function (a, b) { return Number(a.SEQ_NO) - Number(b.SEQ_NO); })
    .map(function (r) { return r.TEXT; });
  assert.deepStrictEqual(plain(rows), ['甲', '乙', '丙（留空，先寫）', '丁（留空，後寫）'], '有效留空亦當 TRUE');
});

// =====================================================================
console.log('\n內容表自動同步（contentAutoSyncTrigger_）');
// =====================================================================

function makeProps() {
  const store = {};
  return {
    store: store,
    service: {
      getScriptProperties: function () {
        return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
          setProperty: function (k, v) { store[k] = String(v); },
          deleteProperty: function (k) { delete store[k]; }
        };
      }
    }
  };
}

function syncEnv(options) {
  const o = options || {};
  const env = contentEnv.makeEnv(Object.assign({
    config: Object.assign({ WEBAPP_SIMULATED_TODAY: '2027-10-15' }, o.config || {}),
    content: {
      家事報告: [
        { SERVICE_DATE: '2027-10-10', SEQ_NO: '10', TEXT: '已經過去的一週', ACTIVE: 'TRUE' },
        { SERVICE_DATE: '2027-10-17', SEQ_NO: '10', TEXT: '下一個主日的報告', ACTIVE: 'TRUE' }
      ]
    }
  }, o.env || {}));
  const props = makeProps();
  env.sandbox.PropertiesService = props.service;
  let mtime = o.mtime === undefined ? 1000 : o.mtime;
  env.sandbox.readContentSheetLastUpdatedMillis_ = function () { return mtime; };
  env.setMtime = function (v) { mtime = v; };
  env.props = props;
  return env;
}

function activeTexts(env, iso) {
  return plainTexts(env, iso);
}
function plainTexts(env, iso) {
  return plain(env.sandbox.readSheet('Announcements').filter(function (r) {
    return r.ACTIVE === true && env.sandbox.formatIsoDate_(env.sandbox.normalizeDate_(r.SERVICE_DATE)) === iso;
  }).map(function (r) { return String(r.TEXT); }));
}

test('只匯入今日及之後的主日；已經過去的主日不動；AuditLog CONTENT_AUTO_SYNC', function () {
  const env = syncEnv({});
  env.sandbox.contentAutoSyncTrigger_();
  assert.deepStrictEqual(activeTexts(env, '2027-10-17'), ['下一個主日的報告']);
  assert.deepStrictEqual(activeTexts(env, '2027-10-10'), [], '今日（模擬）是 2027-10-15，10-10 已經過去，不匯入');
  const audit = env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'CONTENT_AUTO_SYNC'; });
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(env.sandbox.readSheet('ErrorLog').length, 0, JSON.stringify(env.sandbox.readSheet('ErrorLog')));
});

test('內容表修改時間沒有變 → 不開檔、不寫；改了之後下一次就匯入', function () {
  const env = syncEnv({});
  env.sandbox.contentAutoSyncTrigger_();
  const second = plain(env.sandbox.runContentAutoSync_({ source: 'TEST' }));
  assert.strictEqual(second.quarters[0].status, 'UNCHANGED');

  env.contentTabs['家事報告'].getRange(4, 5).setValue('改了內容');
  env.setMtime(2000);
  const third = plain(env.sandbox.runContentAutoSync_({ source: 'TEST' }));
  assert.strictEqual(third.quarters[0].status, 'IMPORTED', JSON.stringify(third));
  assert.deepStrictEqual(activeTexts(env, '2027-10-17'), ['改了內容']);
  const again = plain(env.sandbox.runContentAutoSync_({ source: 'TEST' }));
  assert.strictEqual(again.quarters[0].status, 'UNCHANGED');
});

test('有改動但匯入的結果相同 → NO_CHANGE，不寫 AuditLog', function () {
  const env = syncEnv({});
  env.sandbox.contentAutoSyncTrigger_();
  env.setMtime(3000);
  const r = plain(env.sandbox.runContentAutoSync_({ source: 'TEST' }));
  assert.strictEqual(r.quarters[0].status, 'NO_CHANGE');
  assert.strictEqual(env.sandbox.readSheet('AuditLog').filter(function (x) { return x.ACTION === 'CONTENT_AUTO_SYNC'; }).length, 1);
});

test('匯入失敗（內容表開不到）→ ErrorLog 只記一次；內容表再有改動之前不再試', function () {
  const env = syncEnv({ env: { contentFileMissing: true } });
  env.sandbox.contentAutoSyncTrigger_();
  env.sandbox.contentAutoSyncTrigger_();
  const errors = env.sandbox.readSheet('ErrorLog').filter(function (r) { return r.FUNCTION_NAME === 'runContentAutoSync_'; });
  assert.strictEqual(errors.length, 1, JSON.stringify(errors));
  assert.ok(errors[0].MESSAGE.indexOf('2027T4') !== -1 && errors[0].MESSAGE.indexOf('不會再試') !== -1, errors[0].MESSAGE);
});

test('拿不到鎖 → 不記修改時間，下一次照樣再試', function () {
  const env = syncEnv({ env: { lockFails: true } });
  const r = plain(env.sandbox.runContentAutoSync_({ source: 'TEST' }));
  assert.strictEqual(r.quarters[0].status, 'LOCK_TIMEOUT', JSON.stringify(r));
  assert.deepStrictEqual(Object.keys(env.props.store), [], '沒有記修改時間');
});

test('沙盒季度與停用的內容表不處理；修改時間讀不到就照樣同步', function () {
  const sandboxQ = syncEnv({ config: { SELFTEST_QUARTER_ID: contentEnv.QUARTER_ID } });
  assert.deepStrictEqual(plain(sandboxQ.sandbox.runContentAutoSync_({})).quarters, []);
  const inactive = syncEnv({ env: { contentSheets: [{ QUARTER_ID: contentEnv.QUARTER_ID, FILE_ID: contentEnv.FAKE_CONTENT_FILE_ID, ACTIVE: false }] } });
  assert.deepStrictEqual(plain(inactive.sandbox.runContentAutoSync_({})).quarters, []);
  const unknownTime = syncEnv({ mtime: null });
  unknownTime.sandbox.contentAutoSyncTrigger_();
  assert.strictEqual(plain(unknownTime.sandbox.runContentAutoSync_({})).quarters[0].status, 'NO_CHANGE', '讀不到修改時間 → 每次都核對一次');
});

test('planContentAutoSyncDates_／parseContentAutoSyncMinutes_：純函式', function () {
  const sb = makeWordEnv({}).sandbox;
  const weeks = [
    { QUARTER_ID: 'Q', SERVICE_DATE: '2027-10-24' }, { QUARTER_ID: 'Q', SERVICE_DATE: '2027-10-10' },
    { QUARTER_ID: 'Q', SERVICE_DATE: '2027-10-17', ARCHIVED: true }, { QUARTER_ID: 'X', SERVICE_DATE: '2027-10-31' },
    { QUARTER_ID: 'Q', SERVICE_DATE: '2027-10-15' }
  ];
  assert.deepStrictEqual(plain(sb.planContentAutoSyncDates_(weeks, 'Q', '2027-10-15')), ['2027-10-15', '2027-10-24']);
  assert.deepStrictEqual(plain(sb.parseContentAutoSyncMinutes_('30')), { minutes: 30, valid: true });
  assert.deepStrictEqual(plain(sb.parseContentAutoSyncMinutes_('0')), { minutes: 0, valid: true });
  assert.deepStrictEqual(plain(sb.parseContentAutoSyncMinutes_('')), { minutes: 0, valid: true });
  assert.deepStrictEqual(plain(sb.parseContentAutoSyncMinutes_('60')), { minutes: 60, valid: true });
  assert.deepStrictEqual(plain(sb.parseContentAutoSyncMinutes_('7')), { minutes: 0, valid: false });
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
