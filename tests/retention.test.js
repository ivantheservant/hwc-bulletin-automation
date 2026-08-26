#!/usr/bin/env node
/**
 * tests/retention.test.js
 *
 * R-035（舊季度自動封存）、R-037（環境整理），以及兩個職事表選單改名的
 * 回歸測試。
 *
 * ⚠️ 這一組最要緊的一條，是**「一格資料都不可以刪」**。封存只是「預設不
 * 顯示」——所以測試不只驗「封存之後見不到」，更要驗「取消封存之後完完整整
 * 地回來」，以及「`Retention.gs` 整個檔案沒有任何刪除操作」。
 *
 * 執行方式：node tests/retention.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const vm = require('vm');
const path = require('path');
const fsNode = require('fs');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');

const FAKE_ROSTER_ID = 'FAKE_ROSTER_ID_FOR_RETENTION_TEST';
const SANDBOX_QUARTER = '2030T1';

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
    console.log('    ' + err.message);
  }
}

function baseStubs() {
  return {
    Utilities: {
      formatDate: function (date, tz, pattern) {
        const y = date.getFullYear();
        const mo = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        const hh = String(date.getHours()).padStart(2, '0');
        const mi = String(date.getMinutes()).padStart(2, '0');
        if (String(pattern).indexOf('HH') !== -1) return `${y}-${mo}-${d} ${hh}:${mi}`;
        return `${y}-${mo}-${d}`;
      }
    },
    Session: {
      getScriptTimeZone: function () { return 'Pacific/Auckland'; },
      getActiveUser: function () { return { getEmail: function () { return 'tester@example.org'; } }; },
      getEffectiveUser: function () { return { getEmail: function () { return 'tester@example.org'; } }; }
    },
    CacheService: {},
    HtmlService: {},
    MailApp: { getRemainingDailyQuota: function () { return 100; } },
    DriveApp: { getRootFolder: function () { return { getName: function () { return 'root'; } }; } },
    LockService: {
      getScriptLock: function () {
        return { tryLock: function () { return true; }, releaseLock: function () {} };
      }
    }
  };
}

const boot = loadAllSrcFilesInOrder(baseStubs());

function makeEnv(options) {
  const o = options || {};

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  cfg.ROSTER_SPREADSHEET_ID = FAKE_ROSTER_ID;
  cfg.SELFTEST_QUARTER_ID = SANDBOX_QUARTER;
  Object.assign(cfg, o.config || {});

  const sheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) {
    const def = boot.COLUMNS[id];
    sheets[boot.SHEETS[id]] = makeFakeSheet(def.headers, def.keys, []);
  });
  sheets.Config = makeFakeSheet(boot.COLUMNS.CONFIG.headers, boot.COLUMNS.CONFIG.keys,
    Object.keys(cfg).map(function (k) { return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true }; }));
  Object.keys(sheets).forEach(function (name) { sheets[name].setName(name); });

  const triggers = o.triggers || [];

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs(), {
    SpreadsheetApp: {
      getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); },
      openById: function () { throw new Error('這一組測試不連職事表'); },
      ProtectionType: { SHEET: 'SHEET' },
      getUi: function () { throw new Error('這一組測試不應該用到 UI'); }
    },
    ScriptApp: {
      getProjectTriggers: function () {
        return triggers.map(function (name) {
          return { getHandlerFunction: function () { return name; } };
        });
      }
    }
  }));

  vm.runInContext('function __mkDate(y, m, d) { return new Date(y, m, d); }', sandbox);

  (o.weekRowSpecs || []).forEach(function (spec) {
    const p = spec.isoDate.split('-').map(Number);
    sandbox.writeSheet(sandbox.SHEETS.BULLETIN_WEEKS, [Object.assign({
      SERVICE_DATE: sandbox.__mkDate(p[0], p[1] - 1, p[2]),
      QUARTER_ID: spec.quarterId,
      WEEK_OF_MONTH: 1,
      STATUS: 'DRAFT'
    }, spec.fields || {})]);
  });

  (o.publishRowSpecs || []).forEach(function (spec) {
    const p = spec.isoDate.split('-').map(Number);
    sandbox.writeSheet(sandbox.SHEETS.PUBLISH_LOG, [{
      SERVICE_DATE: sandbox.__mkDate(p[0], p[1] - 1, p[2]),
      VERSION_NO: spec.versionNo || 1,
      PUBLISHED_AT: sandbox.__mkDate(p[0], p[1] - 1, p[2]),
      PUBLISHED_BY: 'tester',
      MASTER_FILE_ID: spec.masterFileId || 'FAKE_MASTER',
      IS_SELFTEST: spec.isSelfTest === true
    }]);
  });

  return { sandbox: sandbox, sheets: sheets };
}

function arr(a) { return Array.prototype.slice.call(a); }

// =====================================================================
// 第 1 組：決定封存哪一季
// =====================================================================

console.log('\n第 1 組：決定封存哪一季');

test('RETENTION_QUARTERS_VISIBLE=2 → 只有本季與前一季可見', function () {
  const env = makeEnv({});
  const plan = env.sandbox.planQuarterRetention_(['2029T1', '2029T2', '2029T3'], 2, '');
  assert.strictEqual(JSON.stringify(arr(plan.visible)), JSON.stringify(['2029T3', '2029T2']));
  assert.strictEqual(JSON.stringify(arr(plan.toArchive)), JSON.stringify(['2029T1']));
});

test('改成 4 → 四季可見，一季都不封存', function () {
  const env = makeEnv({});
  const plan = env.sandbox.planQuarterRetention_(['2029T1', '2029T2', '2029T3', '2029T4'], 4, '');
  assert.strictEqual(plan.visible.length, 4);
  assert.strictEqual(plan.toArchive.length, 0);
});

test('跨年排序正確：2030T1 比 2029T4 新', function () {
  // ⚠️ 用字串比較（YYYYTn 格式下字串序 === 時間序）。寫錯就會把新一季封存。
  const env = makeEnv({});
  const plan = env.sandbox.planQuarterRetention_(['2029T4', '2030T1'], 1, '');
  assert.strictEqual(JSON.stringify(arr(plan.visible)), JSON.stringify(['2030T1']));
  assert.strictEqual(JSON.stringify(arr(plan.toArchive)), JSON.stringify(['2029T4']));
});

test('沙盒季度兩邊都不入：既不可見、也永不封存', function () {
  const env = makeEnv({});
  const plan = env.sandbox.planQuarterRetention_(
    ['2029T1', '2029T2', '2029T3', SANDBOX_QUARTER], 1, SANDBOX_QUARTER);
  assert.strictEqual(plan.visible.indexOf(SANDBOX_QUARTER), -1, '不可以算進可見那 N 季');
  assert.strictEqual(plan.toArchive.indexOf(SANDBOX_QUARTER), -1, '永遠不可以被封存');
  assert.strictEqual(JSON.stringify(arr(plan.sandbox)), JSON.stringify([SANDBOX_QUARTER]));
});

test('保留數不合法 → 退回 2，不會變成 0（0 會把全部季度封存）', function () {
  const env = makeEnv({});
  [0, -1, '亂寫', null].forEach(function (bad) {
    const plan = env.sandbox.planQuarterRetention_(['2029T1', '2029T2', '2029T3'], bad, '');
    assert.strictEqual(plan.visible.length, 2, '保留數 ' + JSON.stringify(bad) + ' 應該退回 2');
  });
});

test('重複的季度 ID 只算一次', function () {
  const env = makeEnv({});
  const plan = env.sandbox.planQuarterRetention_(
    ['2029T1', '2029T1', '2029T2', '2029T2', '2029T3'], 2, '');
  assert.strictEqual(plan.visible.length + plan.toArchive.length, 3);
});

// =====================================================================
// 第 2 組：可見清單與空白提示
// =====================================================================

console.log('\n第 2 組：季度下拉');

test('已封存的季度預設不顯示', function () {
  const env = makeEnv({});
  const list = env.sandbox.visibleQuarterList_(
    ['2029T1', '2029T2'], { '2029T1': true, '2029T2': false }, false, '');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].quarterId, '2029T2');
});

test('勾「顯示已封存」→ 全部列出，而且已封存那些帶標記', function () {
  const env = makeEnv({});
  const list = env.sandbox.visibleQuarterList_(
    ['2029T1', '2029T2'], { '2029T1': true, '2029T2': false }, true, '');
  assert.strictEqual(list.length, 2);
  const archived = list.filter(function (q) { return q.archived === true; });
  assert.strictEqual(archived.length, 1);
  assert.strictEqual(archived[0].quarterId, '2029T1');
});

test('沙盒季度永不出現——勾了「顯示已封存」都不會', function () {
  const env = makeEnv({});
  [false, true].forEach(function (includeArchived) {
    const list = env.sandbox.visibleQuarterList_(
      ['2029T1', SANDBOX_QUARTER], {}, includeArchived, SANDBOX_QUARTER);
    assert.strictEqual(
      list.filter(function (q) { return q.quarterId === SANDBOX_QUARTER; }).length, 0,
      'includeArchived=' + includeArchived + ' 時沙盒季度仍然出現了');
  });
});

test('全部封存 → 可見清單是空的，但提示語存在而且講得出下一步', function () {
  // ⚠️ 這是這條功能最大的風險：「十月回來打開系統見到一片空白」。
  const env = makeEnv({});
  const list = env.sandbox.visibleQuarterList_(
    ['2029T1', '2029T2'], { '2029T1': true, '2029T2': true }, false, '');
  assert.strictEqual(list.length, 0);

  const hint = env.sandbox.RETENTION_EMPTY_HINT_;
  assert.ok(hint, '一定要有提示語');
  assert.ok(hint.indexOf('顯示已封存') !== -1, '要講得出下一步：' + hint);
  assert.ok(hint.indexOf('建立新一季') !== -1, '要講得出另一條路：' + hint);
});

test('listWeeksForWebApp_：預設不含已封存的季度，emptyHint 只在真的空時出現', function () {
  const env = makeEnv({
    weekRowSpecs: [
      { isoDate: '2029-01-07', quarterId: '2029T1', fields: { ARCHIVED: true } },
      { isoDate: '2029-04-01', quarterId: '2029T2' }
    ]
  });
  const data = env.sandbox.listWeeksForWebApp_(false);
  assert.strictEqual(data.quarters.length, 1);
  assert.strictEqual(data.quarters[0].quarterId, '2029T2');
  assert.strictEqual(data.archivedQuarterCount, 1);
  assert.strictEqual(data.emptyHint, '', '仲有一季可見，不應該出提示');

  const withArchived = env.sandbox.listWeeksForWebApp_(true);
  assert.strictEqual(withArchived.quarters.length, 2);
  const archivedGroup = withArchived.quarters.filter(function (g) { return g.archived === true; })[0];
  assert.ok(archivedGroup, '要有一季標記為已封存');
  assert.ok(archivedGroup.label.indexOf('已封存') !== -1,
    '下拉裏面要睇得出邊一季封存咗：' + archivedGroup.label);
});

test('listWeeksForWebApp_：全部封存 → emptyHint 有值', function () {
  const env = makeEnv({
    weekRowSpecs: [{ isoDate: '2029-01-07', quarterId: '2029T1', fields: { ARCHIVED: true } }]
  });
  const data = env.sandbox.listWeeksForWebApp_(false);
  assert.strictEqual(data.quarters.length, 0);
  assert.ok(data.emptyHint, '一個可見季度都沒有時一定要有提示');
});

test('一季之內有一行未封存 → 整季當成未封存（睇得到才修得到）', function () {
  const env = makeEnv({
    weekRowSpecs: [
      { isoDate: '2029-01-07', quarterId: '2029T1', fields: { ARCHIVED: true } },
      { isoDate: '2029-01-14', quarterId: '2029T1' }
    ]
  });
  const rows = env.sandbox.readSheet(env.sandbox.SHEETS.BULLETIN_WEEKS);
  const flags = env.sandbox.quarterArchivedFlags_(rows);
  assert.strictEqual(flags['2029T1'], false,
    '一半封存一半沒有，代表中途出過事——應該照樣顯示，不是靜靜收起');
});

// =====================================================================
// 第 3 組：封存與取消封存
// =====================================================================

console.log('\n第 3 組：封存與取消封存');

test('封存的季度資料一格未刪，取消封存之後完全還原', function () {
  // ⚠️ 這是整條功能唯一一條真正要緊的規則。
  const env = makeEnv({
    weekRowSpecs: [
      { isoDate: '2029-01-07', quarterId: '2029T1', fields: { SERMON_TITLE: '重要的講題', CALL_REF: '詩篇一百篇' } }
    ],
    publishRowSpecs: [{ isoDate: '2029-01-07' }]     // 已發佈，所以不會被 blocker 攔住
  });

  const before = JSON.stringify(env.sandbox.readSheet(env.sandbox.SHEETS.BULLETIN_WEEKS));

  const archived = env.sandbox.archiveQuarter_('2029T1', {});
  assert.strictEqual(archived.ok, true, archived.message);
  assert.strictEqual(archived.weekRows, 1);

  const afterArchive = env.sandbox.readSheet(env.sandbox.SHEETS.BULLETIN_WEEKS);
  assert.strictEqual(afterArchive.length, 1, '⚠️ 一行都不可以刪');
  assert.strictEqual(afterArchive[0].ARCHIVED, true);
  assert.strictEqual(String(afterArchive[0].SERMON_TITLE), '重要的講題', '內容一格都不可以動');
  assert.strictEqual(String(afterArchive[0].CALL_REF), '詩篇一百篇');

  const restored = env.sandbox.unarchiveQuarter_('2029T1');
  assert.strictEqual(restored.ok, true, restored.message);
  const afterRestore = env.sandbox.readSheet(env.sandbox.SHEETS.BULLETIN_WEEKS);
  assert.strictEqual(afterRestore[0].ARCHIVED, false);

  // ⚠️ 逐欄比對，只放行 ARCHIVED 一欄。用整行字串化去比的話，要靠一個
  //    脆弱的字串替換去抵銷「空白 → false」的差異，那種比較一改欄位就壞。
  const beforeRow = JSON.parse(before)[0];
  Object.keys(beforeRow).forEach(function (key) {
    if (key === 'ARCHIVED') return;
    assert.strictEqual(JSON.stringify(afterRestore[0][key]), JSON.stringify(beforeRow[key]),
      '欄位 ' + key + ' 在封存／取消封存之後被改動了');
  });
});

test('沙盒季度直接叫 archiveQuarter_ → 拋錯，不是靜靜略過', function () {
  // ⚠️ 靜靜略過會令呼叫方以為封存成功了。
  const env = makeEnv({});
  let code = '';
  try {
    env.sandbox.archiveQuarter_(SANDBOX_QUARTER, {});
  } catch (err) {
    code = (err && err.code) || '';
  }
  assert.strictEqual(code, 'SANDBOX_QUARTER');
});

test('有未發佈而且有內容的主日 → 不封存，而且列出是邊幾個', function () {
  const env = makeEnv({
    weekRowSpecs: [
      { isoDate: '2029-01-07', quarterId: '2029T1', fields: { SERMON_TITLE: '仲填緊' } }
    ]
  });
  const result = env.sandbox.archiveQuarter_('2029T1', {});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'HAS_UNPUBLISHED_WORK');
  assert.strictEqual(result.blockers.length, 1);
  assert.strictEqual(result.blockers[0].isoDate, '2029-01-07');
  // 而且真的沒有動過那一行。
  const rows = env.sandbox.readSheet(env.sandbox.SHEETS.BULLETIN_WEEKS);
  assert.notStrictEqual(rows[0].ARCHIVED, true, '被攔住就一格都不應該寫');
});

test('force:true → 照樣封存，而且 AuditLog 講明使用者確認過', function () {
  const env = makeEnv({
    weekRowSpecs: [
      { isoDate: '2029-01-07', quarterId: '2029T1', fields: { SERMON_TITLE: '仲填緊' } }
    ]
  });
  const result = env.sandbox.archiveQuarter_('2029T1', { force: true });
  assert.strictEqual(result.ok, true, result.message);

  const audit = env.sandbox.readSheet(env.sandbox.SHEETS.AUDIT_LOG)
    .filter(function (a) { return String(a.ACTION) === 'ARCHIVE_QUARTER'; });
  assert.strictEqual(audit.length, 1);
  assert.ok(String(audit[0].NOTES).indexOf('使用者已確認') !== -1,
    '要記低係人手確認過先封存：' + audit[0].NOTES);
});

test('已發佈的主日不算 blocker（那一季做完了）', function () {
  const env = makeEnv({
    weekRowSpecs: [
      { isoDate: '2029-01-07', quarterId: '2029T1', fields: { SERMON_TITLE: '已經出咗' } }
    ],
    publishRowSpecs: [{ isoDate: '2029-01-07' }]
  });
  assert.strictEqual(env.sandbox.findUnpublishedWorkInQuarter_('2029T1').length, 0);
});

test('自測的發佈紀錄不算「已發佈」（那一期沒有寄給會眾）', function () {
  const env = makeEnv({
    weekRowSpecs: [
      { isoDate: '2029-01-07', quarterId: '2029T1', fields: { SERMON_TITLE: '仲填緊' } }
    ],
    publishRowSpecs: [{ isoDate: '2029-01-07', isSelfTest: true }]
  });
  assert.strictEqual(env.sandbox.findUnpublishedWorkInQuarter_('2029T1').length, 1,
    '自測的發佈不可以令一個仍然在做的主日看起來像做完了');
});

test('完全空白的主日不算 blocker（未填的一季可以直接收起）', function () {
  const env = makeEnv({
    weekRowSpecs: [{ isoDate: '2029-01-07', quarterId: '2029T1' }]
  });
  assert.strictEqual(env.sandbox.findUnpublishedWorkInQuarter_('2029T1').length, 0);
});

test('封存不會碰 Diagnostics／PublishLog／AuditLog／SendLog 的既有內容', function () {
  const env = makeEnv({
    weekRowSpecs: [{ isoDate: '2029-01-07', quarterId: '2029T1' }],
    publishRowSpecs: [{ isoDate: '2029-01-07' }]
  });
  const S = env.sandbox.SHEETS;
  const before = {
    diagnostics: env.sandbox.readSheet(S.DIAGNOSTICS).length,
    publishLog: env.sandbox.readSheet(S.PUBLISH_LOG).length,
    sendLog: env.sandbox.readSheet(S.SEND_LOG).length
  };

  env.sandbox.archiveQuarter_('2029T1', {});

  assert.strictEqual(env.sandbox.readSheet(S.DIAGNOSTICS).length, before.diagnostics);
  assert.strictEqual(env.sandbox.readSheet(S.PUBLISH_LOG).length, before.publishLog);
  assert.strictEqual(env.sandbox.readSheet(S.SEND_LOG).length, before.sendLog);
  // AuditLog 一定會多一筆（封存本身要記帳），但**只可以多**，不可以少。
  assert.ok(env.sandbox.readSheet(S.AUDIT_LOG).length >= 1, 'AuditLog 應該多一筆封存紀錄');
});

test('⚠️ 靜態檢查：Retention.gs 沒有任何刪除操作', function () {
  // ⚠️ 這一條比行為測試更徹底：它連「將來有人加一行 deleteRow」都攔得住。
  //    封存的整條規則就是「一格資料都不刪」。
  const src = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'Retention.gs'), 'utf8');
  const forbidden = ['deleteRow', 'deleteRows', 'deleteSheet', 'deleteColumn',
    'clearContent', 'clear(', 'removeSheet', 'setTrashed'];
  const found = [];
  src.split(/\r?\n/).forEach(function (line, i) {
    const trimmed = line.trim();
    if (trimmed.indexOf('*') === 0 || trimmed.indexOf('//') === 0) return;   // 註解不算
    forbidden.forEach(function (bad) {
      if (line.indexOf(bad) !== -1) found.push('第 ' + (i + 1) + ' 行：' + bad);
    });
  });
  assert.strictEqual(found.length, 0, '封存絕對不可以刪任何東西，實際：' + found.join('、'));
});

test('⚠️ 靜態檢查：Retention.gs 沒有碰那四張紀錄表', function () {
  const src = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'Retention.gs'), 'utf8');
  const forbidden = ['SHEETS.DIAGNOSTICS', 'SHEETS.SEND_LOG', 'SHEETS.ERROR_LOG'];
  const found = [];
  src.split(/\r?\n/).forEach(function (line, i) {
    const trimmed = line.trim();
    if (trimmed.indexOf('*') === 0 || trimmed.indexOf('//') === 0) return;
    forbidden.forEach(function (bad) {
      if (line.indexOf(bad) !== -1) found.push('第 ' + (i + 1) + ' 行：' + bad);
    });
  });
  assert.strictEqual(found.length, 0,
    '那四張是紀錄，封存它們等於把稽核軌跡藏起來，實際：' + found.join('、'));
  // PublishLog 只准**讀**（findUnpublishedWorkInQuarter_ 要知道邊個發佈咗），
  // 不准寫。
  assert.strictEqual(src.indexOf('writeSheet(SHEETS.PUBLISH_LOG'), -1);
});

// =====================================================================
// 第 4 組：R-037 上線前檢查
// =====================================================================

console.log('\n第 4 組：上線前檢查（八項）');

function goLiveItem(env, keyword) {
  return env.sandbox.buildGoLiveChecklist_().filter(function (i) {
    return String(i.label).indexOf(keyword) !== -1;
  })[0];
}

test('八項齊備，一項都不可以少', function () {
  const env = makeEnv({});
  const items = env.sandbox.buildGoLiveChecklist_();
  assert.strictEqual(items.length, 8, '實際：' + items.map(function (i) { return i.label; }).join('、'));
  items.forEach(function (i) {
    assert.ok(i.label && i.status && i.message, '每一項都要有標題、燈色、說明：' + JSON.stringify(i));
  });
});

test('1. Recipients 缺 IT → 🟡 並講出缺邊一組', function () {
  const env = makeEnv({});
  env.sandbox.writeSheet(env.sandbox.SHEETS.RECIPIENTS, [
    { GROUP_NAME: 'CC', NAME: '甲', EMAIL: 'cc@example.org', ACTIVE: true },
    { GROUP_NAME: 'DB', NAME: '乙', EMAIL: 'db@example.org', ACTIVE: true }
  ]);
  const item = goLiveItem(env, 'Recipients');
  assert.strictEqual(item.status, env.sandbox.SELF_CHECK_STATUS_.YELLOW);
  assert.ok(item.message.indexOf('IT') !== -1, item.message);
});

test('1. 三組齊備 → 🟢', function () {
  const env = makeEnv({});
  env.sandbox.writeSheet(env.sandbox.SHEETS.RECIPIENTS, [
    { GROUP_NAME: 'CC', NAME: '甲', EMAIL: 'cc@example.org', ACTIVE: true },
    { GROUP_NAME: 'DB', NAME: '乙', EMAIL: 'db@example.org', ACTIVE: true },
    { GROUP_NAME: 'IT', NAME: '丙', EMAIL: 'it@example.org', ACTIVE: true }
  ]);
  assert.strictEqual(goLiveItem(env, 'Recipients').status, env.sandbox.SELF_CHECK_STATUS_.GREEN);
});

test('2. DRY_RUN=TRUE → 🟡「測試模式」；FALSE → 🟢「正式模式」', function () {
  const S = boot.SELF_CHECK_STATUS_;
  const dry = makeEnv({ config: { DRY_RUN: 'TRUE' } });
  const item1 = goLiveItem(dry, '寄送模式');
  assert.strictEqual(item1.status, S.YELLOW);
  assert.ok(item1.message.indexOf('測試模式') !== -1, item1.message);

  const live = makeEnv({ config: { DRY_RUN: 'FALSE' } });
  const item2 = goLiveItem(live, '寄送模式');
  assert.strictEqual(item2.status, S.GREEN);
  assert.ok(item2.message.indexOf('正式模式') !== -1, item2.message);
});

test('3. PREVIEW_WEBAPP_URL 空白 → 🟡，講明觸發器情境取不到', function () {
  const env = makeEnv({ config: { PREVIEW_WEBAPP_URL: '' } });
  const item = goLiveItem(env, '草稿預覽網址');
  assert.strictEqual(item.status, env.sandbox.SELF_CHECK_STATUS_.YELLOW);
  assert.ok(item.message.indexOf('觸發器') !== -1, item.message);

  const filled = makeEnv({ config: { PREVIEW_WEBAPP_URL: 'https://example.org/exec' } });
  assert.strictEqual(goLiveItem(filled, '草稿預覽網址').status, boot.SELF_CHECK_STATUS_.GREEN);
});

test('4. 星期一觸發器：0 個 🟡、1 個 🟢、2 個 🔴', function () {
  const S = boot.SELF_CHECK_STATUS_;
  const none = makeEnv({ triggers: [] });
  assert.strictEqual(goLiveItem(none, '星期一觸發器').status, S.YELLOW);

  const one = makeEnv({ triggers: ['weeklyBulletinSendTrigger_'] });
  assert.strictEqual(goLiveItem(one, '星期一觸發器').status, S.GREEN);

  const two = makeEnv({ triggers: ['weeklyBulletinSendTrigger_', 'weeklyBulletinSendTrigger_'] });
  const item = goLiveItem(two, '星期一觸發器');
  assert.strictEqual(item.status, S.RED, '兩個觸發器＝同一期寄兩次給全教會');
  assert.ok(item.message.indexOf('2 次') !== -1, '要講明後果：' + item.message);
});

test('4. 其他觸發器不算（只數 weeklyBulletinSendTrigger_）', function () {
  const env = makeEnv({ triggers: ['onFillGridEdit_', 'weeklyBulletinSendTrigger_'] });
  assert.strictEqual(goLiveItem(env, '星期一觸發器').status, boot.SELF_CHECK_STATUS_.GREEN);
});

test('5. 兩個 master ID 相同 → 🔴', function () {
  const env = makeEnv({
    config: { PUBLISHED_PDF_FILE_ID: 'SAME_FAKE_ID', SELFTEST_MASTER_PDF_FILE_ID: 'SAME_FAKE_ID' }
  });
  assert.strictEqual(goLiveItem(env, 'master 檔案').status, env.sandbox.SELF_CHECK_STATUS_.RED);
});

test('6. ErrorLog 最近 7 日有錯 → 🟡，並講出最新一筆', function () {
  const env = makeEnv({});
  const now = new Date();
  env.sandbox.writeSheet(env.sandbox.SHEETS.ERROR_LOG, [{
    TIMESTAMP: env.sandbox.__mkDate(now.getFullYear(), now.getMonth(), now.getDate()),
    SOURCE: 'MENU', FUNCTION_NAME: 'test', ERROR_CODE: 'TEST_CODE',
    MESSAGE: '測試錯誤訊息', DETAIL: ''
  }]);
  const item = goLiveItem(env, '最近 7 日的錯誤');
  assert.strictEqual(item.status, env.sandbox.SELF_CHECK_STATUS_.YELLOW);
  assert.ok(item.message.indexOf('TEST_CODE') !== -1, '要講出最新一筆：' + item.message);
});

test('6. 沒有錯誤 → 🟢', function () {
  const env = makeEnv({});
  assert.strictEqual(goLiveItem(env, '最近 7 日的錯誤').status, boot.SELF_CHECK_STATUS_.GREEN);
});

test('6. 舊過 7 日的錯誤不算', function () {
  const env = makeEnv({});
  const old = new Date(new Date().getTime() - (30 * 24 * 60 * 60 * 1000));
  env.sandbox.writeSheet(env.sandbox.SHEETS.ERROR_LOG, [{
    TIMESTAMP: env.sandbox.__mkDate(old.getFullYear(), old.getMonth(), old.getDate()),
    SOURCE: 'MENU', FUNCTION_NAME: 'test', ERROR_CODE: 'OLD', MESSAGE: '舊錯誤', DETAIL: ''
  }]);
  assert.strictEqual(goLiveItem(env, '最近 7 日的錯誤').status, boot.SELF_CHECK_STATUS_.GREEN);
});

test('8. 沙盒季度不在使用者可見範圍 → 🟢', function () {
  const env = makeEnv({
    weekRowSpecs: [
      { isoDate: '2029-01-07', quarterId: '2029T1' },
      { isoDate: '2030-01-06', quarterId: SANDBOX_QUARTER }
    ]
  });
  const item = goLiveItem(env, '沙盒季度');
  assert.strictEqual(item.status, env.sandbox.SELF_CHECK_STATUS_.GREEN, item.message);
});

// =====================================================================
// 第 5 組：R-037 正式報表排除自測資料
// =====================================================================

console.log('\n第 5 組：正式報表排除自測資料');

test('readOfficialPublishLogRows_：自測的行一行都不會回', function () {
  const env = makeEnv({
    publishRowSpecs: [
      { isoDate: '2027-11-07', isSelfTest: false },
      { isoDate: '2030-01-06', isSelfTest: true }
    ]
  });
  const rows = env.sandbox.readOfficialPublishLogRows_();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(env.sandbox.publishRowIsoDate_(rows[0]), '2027-11-07');
});

test('IS_SELFTEST 空白當成「不是自測」（舊資料那一欄可能是空的）', function () {
  const env = makeEnv({});
  env.sandbox.writeSheet(env.sandbox.SHEETS.PUBLISH_LOG, [{
    SERVICE_DATE: env.sandbox.__mkDate(2027, 10, 7), VERSION_NO: 1,
    PUBLISHED_AT: env.sandbox.__mkDate(2027, 10, 7), PUBLISHED_BY: 'x',
    MASTER_FILE_ID: 'FAKE'
  }]);
  assert.strictEqual(env.sandbox.readOfficialPublishLogRows_().length, 1);
});

test('自我檢測「最近一次發佈」不會指住沙盒那一期', function () {
  const env = makeEnv({
    publishRowSpecs: [
      { isoDate: '2027-11-07', isSelfTest: false, versionNo: 3 },
      // 沙盒那一行比較新——不排除的話會變成「最近一次發佈」。
      { isoDate: '2030-01-06', isSelfTest: true, versionNo: 9 }
    ]
  });
  const summary = env.sandbox.runSelfCheck_();
  const item = summary.items.filter(function (i) {
    return String(i.label).indexOf('最近一次發佈') !== -1;
  })[0];
  assert.ok(item, '應該有這一項');
  assert.ok(item.message.indexOf('2027-11-07') !== -1, item.message);
  assert.strictEqual(item.message.indexOf('2030-01-06'), -1,
    '⚠️ 沙盒那一期不應該出現在正式報表：' + item.message);
});

test('⚠️ 靜態檢查：正式報表那三處都經 readOfficialPublishLogRows_', function () {
  // ⚠️ 逐處點名。將來有人加一個「直接 readSheet(PUBLISH_LOG)」的正式報表，
  //    這一條攔不到，但至少釘住現有那三處不會被改回去。
  const pub = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'Publish.gs'), 'utf8');
  const check = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'SelfCheck.gs'), 'utf8');

  assert.ok(pub.indexOf('var rows = readOfficialPublishLogRows_();') !== -1,
    '頂部狀態列要經共用那一支');
  assert.ok(pub.indexOf('latestPublishLogRow_(readOfficialPublishLogRows_())') !== -1,
    '發佈前檢查要經共用那一支');
  assert.ok(pub.indexOf('nextPublishVersion_(readOfficialPublishLogRows_(), isoDate)') !== -1,
    '版本號要經共用那一支');
  assert.ok(check.indexOf('var publishRows = readOfficialPublishLogRows_();') !== -1,
    '自我檢測「最近一次發佈」要經共用那一支');
});

// =====================================================================
// 第 6 組：工作表保護與選單改名
// =====================================================================

console.log('\n第 6 組：工作表保護與選單改名');

test('MonkeyState 已納入受保護清單（機器寫的那一張）', function () {
  const names = arr(boot.protectedSheetNames_());
  assert.ok(names.indexOf(boot.SHEETS.MONKEY_STATE) !== -1, 'MonkeyState 應該受保護');
  assert.strictEqual(names.filter(function (n) { return !n; }).length, 0,
    '清單裏面不可以有 undefined（打錯 SHEETS 的鍵就會這樣，而且靜靜地不保護那一張）');
});

test('人手要填的八張**刻意不保護**（保護它們等於弄壞流程）', function () {
  const names = arr(boot.protectedSheetNames_());
  ['ANNOUNCEMENTS', 'PRAYERS', 'FELLOWSHIPS', 'FINANCE',
    'PERSON_DISPLAY', 'HONORIFIC_LOOKUP', 'RECIPIENTS', 'FELLOWSHIP_DEFAULTS'
  ].forEach(function (id) {
    assert.strictEqual(names.indexOf(boot.SHEETS[id]), -1,
      boot.SHEETS[id] + ' 是人手要填的，不可以設成受保護');
  });
});

test('兩個職事表選單的名稱都答到「會不會覆寫」', function () {
  // ⚠️ 「會不會覆寫我填的東西」是幹事最怕的事。名稱一定要答到這條問題。
  const menu = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'Menu.gs'), 'utf8');
  const index = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Index.html'), 'utf8');

  assert.ok(menu.indexOf('補抓空白的事奉欄位（整季，不覆寫已填的）') !== -1,
    '選單那一個要講明「不覆寫已填的」');
  assert.ok(index.indexOf('重讀職事表（本主日，不覆寫）') !== -1,
    'UI 按鈕那一個要講明「不覆寫」');
  assert.strictEqual(menu.indexOf('從職事表補抓'), -1, '舊名不應該再出現');
});

test('兩個名稱分得出範圍（一個講「本主日」、一個講「整季」）', function () {
  const menu = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'Menu.gs'), 'utf8');
  const index = fsNode.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'Index.html'), 'utf8');
  assert.ok(menu.indexOf('整季') !== -1, '選單那一個要講明係整季');
  assert.ok(index.indexOf('本主日') !== -1, 'UI 那一個要講明只係本主日');
});

// =====================================================================

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
