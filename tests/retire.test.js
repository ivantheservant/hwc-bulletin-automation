#!/usr/bin/env node
/**
 * tests/retire.test.js
 *
 * 內容表 v2（工作介面精簡為「填寫介面＋內容表」）：停用季度填寫表與講員表格。
 *
 * 停用一個功能，要數齊它的**每一個入口與副作用**（docs/已知bug類型.md bug class 33、47）：選單、
 * 舊選單（部署前已開着的試算表仍然有舊項目）、觸發器、星期一自動流程、全季演練、不帶底線的公開 api、
 * 儲存副作用、封存還原、填寫介面的按鈕。這個檔案逐個入口驗「一格都不寫」，全部經真正入口。
 *
 * 執行方式：node tests/retire.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeFillEnv, QUARTER_ID, SERVICE_DATES } = require('./helpers/fillEnv');
const { makeFakeFormApp } = require('./helpers/fakeForm');
const { assertWrittenChinese } = require('./helpers/writtenChinese');

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
    console.log('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err));
  }
}

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
}

/** 造一個會記錄選單結構與對話框的假 UI（與 tests/selfcheck.test.js 的 recordingUi 同一個做法）。 */
function recordingUi(store) {
  store.alerts = store.alerts || [];
  return {
    createMenu: function (name) {
      const menu = { name: name, items: [] };
      const api = {
        __menu: menu,
        addItem: function (label, fn) { menu.items.push({ label: label, fn: fn }); return api; },
        addSeparator: function () { menu.items.push({ separator: true }); return api; },
        addSubMenu: function (sub) { menu.items.push({ sub: sub.__menu }); return api; },
        addToUi: function () { store.top = menu; return api; }
      };
      return api;
    },
    alert: function (title, message) { store.alerts.push({ title: title, message: message }); return 'OK'; }
  };
}

/** 選單內全部項目（包括子選單）。 */
function flattenMenu(menu) {
  const out = [];
  (function walk(m, parent) {
    m.items.forEach(function (i) {
      if (i.sub) return walk(i.sub, i.sub.name);
      if (i.fn) out.push({ label: i.label, fn: i.fn, parent: parent });
    });
  })(menu, menu.name);
  return out;
}

/** 把會被寫到的工作表拍一張快照，比較「一格都沒有寫」。 */
function snapshotSheets(env) {
  const out = {};
  ['BulletinWeeks', 'FillSnapshot', 'AuditLog', 'SendLog', 'ConflictNoticeLog', 'WeekSnapshots', 'FieldOverride', 'DutyOverride']
    .forEach(function (n) { out[n] = JSON.stringify(env.sandbox.readSheet(n)); });
  const grid = env.sheets['Fill_' + QUARTER_ID];
  out.grid = grid ? JSON.stringify(grid.__data) : '';
  out.sheetNames = JSON.stringify(Object.keys(env.sheets).sort());
  out.triggers = JSON.stringify(env.triggers.installed.map(function (t) { return t.getHandlerFunction(); }));
  return out;
}

function assertSame(before, after, label) {
  Object.keys(before).forEach(function (k) {
    assert.strictEqual(after[k], before[k], (label || '') + '：' + k + ' 不應該有任何變動');
  });
}

/** 季度填寫表已停用之後不可以再出現在選單上的處理函式。 */
const RETIRED_FILL_MENU_HANDLERS = [
  'menuCreateOrRefreshFillGrid_', 'menuSyncFillGrid_', 'menuResolveFillConflicts_',
  'menuCheckFillGridAppearance_', 'menuSendFillInvite_', 'menuCheckMissingQuarters_',
  'menuInstallFillReconcileTrigger_', 'menuRemoveFillReconcileTrigger_'
];

// =====================================================================
// Commit 2：停用季度填寫表
// =====================================================================

console.log('\n停用季度填寫表');

test('R2-1 onOpen：子選單叫「季度工具」，沒有填寫表各項；稽核觸發器兩項改名；引用的處理函式全部存在', function () {
  const store = {};
  const env = makeFillEnv({ ui: recordingUi(store) });
  env.sandbox.onOpen();
  const items = flattenMenu(store.top);

  const subNames = [];
  (function walk(m) { m.items.forEach(function (i) { if (i.sub) { subNames.push(i.sub.name); walk(i.sub); } }); })(store.top);
  assert.ok(subNames.indexOf('季度工具') !== -1, '子選單：' + subNames.join('、'));
  assert.strictEqual(subNames.indexOf('季度填寫表'), -1, '不可以再有「季度填寫表」子選單');

  const retiredInMenu = items.filter(function (i) { return RETIRED_FILL_MENU_HANDLERS.indexOf(i.fn) !== -1; });
  assert.deepStrictEqual(retiredInMenu, [], '選單仍然引用已停用的項目');
  // 唯一例外是 Commit 4 的「停用舊功能（季度填寫表、講員表格）」——它正是把舊功能收起的那一項。
  assert.strictEqual(items.filter(function (i) {
    return i.label.indexOf('填寫表') !== -1 && i.fn !== 'menuRetireLegacyFeatures_';
  }).length, 0, '選單不可以再有任何「填寫表」字眼：' + items.map(function (i) { return i.label; }).join('、'));

  const tools = items.filter(function (i) { return i.parent === '季度工具'; }).map(function (i) { return i.label + '→' + i.fn; });
  assert.ok(tools.indexOf('安裝 Config 改動稽核觸發器→menuInstallFillEditTrigger_') !== -1, tools.join('、'));
  assert.ok(tools.indexOf('移除 Config 改動稽核觸發器→menuRemoveFillEditTrigger_') !== -1, tools.join('、'));

  const missing = items.filter(function (i) { return typeof env.sandbox[i.fn] !== 'function'; });
  assert.deepStrictEqual(missing, [], '選單引用了不存在的處理函式');
});

test('R2-2 舊選單（部署前已開着的試算表）：每一個已停用的項目只顯示「已停用」，一格都不寫、不裝觸發器、不建 Fill_', function () {
  RETIRED_FILL_MENU_HANDLERS.filter(function (fn) { return fn !== 'menuRemoveFillReconcileTrigger_'; }).forEach(function (fn) {
    const store = {};
    const env = makeFillEnv({ withGrid: false, ui: recordingUi(store), config: { DRY_RUN: 'FALSE' } });
    const before = snapshotSheets(env);
    env.sandbox[fn]();
    assertSame(before, snapshotSheets(env), fn);
    assert.strictEqual(env.mail.calls.length, 0, fn + '：不可以寄信');
    assert.strictEqual(store.alerts.length, 1, fn + '：要有一個對話框');
    assert.ok(store.alerts[0].message.indexOf('季度填寫表已停用') !== -1, fn + '：' + store.alerts[0].message);
  });
});

test('R2-3 星期一觸發器（weeklyBulletinSendTrigger_）：不建立 Fill_、不寄填寫邀請；內容表那一步照舊執行', function () {
  const env = makeFillEnv({ withGrid: false, config: { DRY_RUN: 'FALSE' } });
  let contentStepCalls = 0;
  env.sandbox.autoCreateContentSheetsForUpcomingQuarters_ = function () {
    contentStepCalls++;
    return { created: [], invited: [], skipped: [] };
  };
  env.sandbox.weeklyBulletinSendTrigger_();

  assert.strictEqual(Object.keys(env.sheets).filter(function (n) { return /^Fill_/.test(n); }).length, 0, '不可以建立 Fill_');
  assert.strictEqual(env.sandbox.readSheet('SendLog').filter(function (r) { return r.STATUS === 'FILL_INVITE'; }).length, 0);
  assert.strictEqual(env.sandbox.readSheet('ConflictNoticeLog').filter(function (r) { return r.POST_ID === 'FILL_INVITE'; }).length, 0);
  assert.strictEqual(contentStepCalls, 1, '內容表的自動建立與邀請那一步要照舊執行');
});

test('R2-4 apiResolveFillConflicts（不帶底線的公開函式）：回 FILL_GRID_RETIRED，一格都不寫', function () {
  const env = makeFillEnv({});
  const before = snapshotSheets(env);
  const resp = env.sandbox.apiResolveFillConflicts(QUARTER_ID, [{ isoDate: SERVICE_DATES[0], fieldKey: 'PRELUDE', choice: 'GRID' }]);
  assert.strictEqual(resp.ok, false);
  assert.strictEqual(resp.error.code, 'FILL_GRID_RETIRED');
  assert.ok(resp.error.message.indexOf('季度填寫表已停用') !== -1, resp.error.message);
  assertSame(before, snapshotSheets(env), 'apiResolveFillConflicts');
});

test('R2-5 fillReconcileTrigger_（觸發器拆之前仍然會觸發）：一格都不寫、不寄信、不寫 ErrorLog', function () {
  const env = makeFillEnv({ config: { DRY_RUN: 'FALSE' } });
  // 格子表有一格未同步的改動：以前對帳會把它寫回週報。
  const sheet = env.sheets['Fill_' + QUARTER_ID];
  sheet.getRange(4, env.sandbox.fillGridColumnIndex_('PRELUDE')).setValue('格子表的序樂');
  const before = snapshotSheets(env);
  env.sandbox.fillReconcileTrigger_();
  assertSame(before, snapshotSheets(env), 'fillReconcileTrigger_');
  assert.strictEqual(env.sandbox.readSheet('ErrorLog').length, 0);
  assert.strictEqual(env.mail.calls.length, 0);
});

test('R2-6 全季流程演練（runQuarterRehearsal_）：不再建立 Fill_', function () {
  const env = makeFillEnv({ withGrid: false });
  env.sandbox.runQuarterRehearsal_(QUARTER_ID);
  assert.strictEqual(Object.keys(env.sheets).filter(function (n) { return /^Fill_/.test(n); }).length, 0,
    '演練會替真實季度建立 Fill_，停用之後不可以再建');
});

test('R2-7 取消封存（unarchiveQuarter_）：Fill_ 維持隱藏，訊息講明季度填寫表已停用', function () {
  const env = makeFillEnv({});
  const sheet = env.sheets['Fill_' + QUARTER_ID];
  sheet.hideSheet();
  const result = env.sandbox.unarchiveQuarter_(QUARTER_ID);
  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(sheet.isSheetHidden(), true, '取消封存不可以令已停用的分頁重新出現');
  assert.ok(result.message.indexOf('季度填寫表已停用') !== -1, result.message);
});

test('R2-8 儲存（saveWeekFromWebApp_）與重設（resetWeekFromWebApp_）：Fill_ 與 FillSnapshot 一格都不變', function () {
  const env = makeFillEnv({});
  const gridBefore = JSON.stringify(env.sheets['Fill_' + QUARTER_ID].__data);
  const snapBefore = JSON.stringify(env.sandbox.readSheet('FillSnapshot'));
  env.sandbox.saveWeekFromWebApp_({
    isoDate: SERVICE_DATES[0], lastSavedAt: '', baseWeek: { PRELUDE: '' }, week: { PRELUDE: '介面改的序樂' }
  });
  const token = env.sandbox.canonicalSaveToken_(env.sandbox.readBulletinWeekRowWithRowNo_(SERVICE_DATES[0]).LAST_SAVED_AT);
  env.sandbox.resetWeekFromWebApp_(SERVICE_DATES[0], token);
  assert.strictEqual(JSON.stringify(env.sheets['Fill_' + QUARTER_ID].__data), gridBefore, 'Fill_ 不可以被改');
  assert.strictEqual(JSON.stringify(env.sandbox.readSheet('FillSnapshot')), snapBefore, 'FillSnapshot 不可以被改');
});

test('R2-9 填寫介面：apiLoadWeek 不再送 fillGridUrl；Index.html、Script.html 沒有「開啟本季填寫表」', function () {
  const env = makeFillEnv({});
  const data = env.sandbox.loadWeekForWebApp_(SERVICE_DATES[0]);
  assert.strictEqual('fillGridUrl' in data, false);
  const index = readSrc('src/ui/Index.html');
  const script = readSrc('src/ui/Script.html');
  ['fillGridLink', '開啟本季填寫表'].forEach(function (needle) {
    assert.strictEqual(index.indexOf(needle), -1, 'Index.html 仍然有 ' + needle);
    assert.strictEqual(script.indexOf(needle), -1, 'Script.html 仍然有 ' + needle);
  });
  assert.strictEqual(readSrc('src/WebApp.gs').indexOf('buildFillGridUrlForWebApp_'), -1);
});

test('R2-10 onFillGridEdit_：Config 那一格照舊記 CONFIG_MANUAL_EDIT（同一個觸發器兼做 Config 稽核，不可以一併停掉）', function () {
  const env = makeFillEnv({});
  const config = env.sheets.Config;
  config.getName = function () { return 'Config'; };
  const rowNo = 3;
  env.sandbox.onFillGridEdit_({
    oldValue: '舊值',
    range: {
      getSheet: function () { return config; },
      getRow: function () { return rowNo; },
      getColumn: function () { return 2; },
      getNumRows: function () { return 1; },
      getNumColumns: function () { return 1; }
    }
  });
  const audit = env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'CONFIG_MANUAL_EDIT'; });
  assert.strictEqual(audit.length, 1, 'Config 稽核要照舊運作');
});

// =====================================================================
// Commit 3：停用講員表格（處理答案、核對警告、三個 api 的行為見 tests/stage3.test.js）
// =====================================================================

console.log('\n停用講員表格');

const SPEAKER_FORM_APIS = ['apiCreateSpeakerForm', 'apiRefreshSpeakerFormDates', 'apiGetSpeakerFormStatus'];

test('R3-1 填寫介面：Index.html、Style.html 沒有「講員表格」區塊；Script.html（註解以外）不再呼叫三個講員表格 api', function () {
  const index = readSrc('src/ui/Index.html');
  const style = readSrc('src/ui/Style.html');
  const script = readSrc('src/ui/Script.html');
  const scriptCode = script.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
  ['speakerForm', 'speaker-form', '講員表格'].forEach(function (needle) {
    assert.strictEqual(index.indexOf(needle), -1, 'Index.html 仍然有 ' + needle);
    assert.strictEqual(style.indexOf(needle), -1, 'Style.html 仍然有 ' + needle);
    assert.strictEqual(scriptCode.indexOf(needle), -1, 'Script.html 仍然有 ' + needle);
  });
  SPEAKER_FORM_APIS.forEach(function (api) {
    assert.strictEqual(scriptCode.indexOf(api), -1, 'Script.html 仍然呼叫 ' + api);
  });
});

test('R3-2 三個講員表格 api（不帶底線的公開函式）：回 SPEAKER_FORM_RETIRED，一格都不寫', function () {
  SPEAKER_FORM_APIS.forEach(function (api) {
    const env = makeFillEnv({ withGrid: false, config: { SPEAKER_FORM_FOLDER_ID: 'FOLDER' } });
    const before = snapshotSheets(env);
    const configBefore = JSON.stringify(env.sandbox.readSheet('Config'));
    const resp = env.sandbox[api]();
    assert.strictEqual(resp.ok, false, api);
    assert.strictEqual(resp.error.code, 'SPEAKER_FORM_RETIRED', api);
    assert.ok(resp.error.message.indexOf('講員表格已停用') !== -1, resp.error.message);
    assertSame(before, snapshotSheets(env), api);
    assert.strictEqual(JSON.stringify(env.sandbox.readSheet('Config')), configBefore, api + '：Config 不可以變');
  });
});

test('R3-3 週報資料模型（buildBulletinModel_）不再呼叫講員核對；SPEAKER_FORM_MISMATCH 只剩純函式本身', function () {
  const model = readSrc('src/BulletinModel.gs').split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
  assert.strictEqual(model.indexOf('speakerMismatchWarningForModel_('), -1);
  const env = makeFillEnv({ withGrid: false });
  env.sandbox.writeSheet('SpeakerFormSubmissions', [{
    TIMESTAMP: new Date(), SERVICE_DATE: env.sandbox.normalizeDate_(SERVICE_DATES[0]), RESPONDENT_EMAIL: 'a@x.com',
    SPEAKER_NAME: '完全不同的名字', SCRIPTURE_REF: '', SERMON_TITLE: '', NOTES: '', RESULT: 'APPLIED', DETAIL: '', ACTIVE: true
  }]);
  const codes = env.sandbox.buildBulletinModel_(SERVICE_DATES[0]).warnings.map(function (w) { return w.code; });
  assert.strictEqual(codes.indexOf('SPEAKER_FORM_MISMATCH'), -1, codes.join('、'));
});

// =====================================================================
// Commit 4：觸發器預期清單（唯一真相）＋「季度工具 ▸ 停用舊功能」
// =====================================================================

console.log('\n觸發器清單與停用舊功能');

const OLD_DEFAULT_INVITE_GROUPS = 'CC,DB,ADMIN,IT';
const OLD_DEFAULT_OWNERS = '家事報告=幹事,代禱事項=堂委,團契聚會=堂委,財政報告=執事,崇拜人數=幹事,宣召=幹事';

/** 一個假觸發器（inspectProjectTriggers_ 用得到的兩個方法）。 */
function fakeTrigger(handler) {
  return { getHandlerFunction: function () { return handler; }, getEventType: function () { return 'CLOCK'; } };
}

/**
 * 部署前的樣子：四種觸發器各 1 個、季度填寫表分頁未隱藏、講員表格已建立並仍然收件、
 * Config 仍然是舊預設值。UI 替身按 `answers` 逐個回答「是／否」，對話框內容記在 `store.alerts`。
 */
function makeLegacyEnv(options) {
  const o = options || {};
  const store = { alerts: [] };
  const answers = (o.answers || ['YES']).slice();
  const forms = makeFakeFormApp(o.formOptions);
  const form = forms.FormApp.create('粵語堂主日講員資料');
  const env = makeFillEnv({
    config: Object.assign({
      SPEAKER_FORM_ID: form.getId(),
      CONTENT_SHEET_INVITE_GROUPS: OLD_DEFAULT_INVITE_GROUPS,
      CONTENT_SHEET_OWNERS: OLD_DEFAULT_OWNERS
    }, o.config || {}),
    extraStubs: { FormApp: forms.FormApp },
    ui: {
      alert: function (title, message, buttons) {
        store.alerts.push({ title: title, message: message, buttons: buttons });
        return buttons === 'YES_NO' ? (answers.shift() || 'NO') : 'OK';
      }
    }
  });
  (o.triggers || ['weeklyBulletinSendTrigger_', 'onFillGridEdit_', 'fillReconcileTrigger_', 'onSpeakerFormSubmit_'])
    .forEach(function (h) { env.triggers.installed.push(fakeTrigger(h)); });
  env.store = store;
  env.form = form;
  env.forms = forms;
  return env;
}

function handlersOf(env) {
  return env.triggers.installed.map(function (t) { return t.getHandlerFunction(); }).sort();
}

function grid(env) {
  return env.sheets['Fill_' + QUARTER_ID];
}

function retireAudit(env) {
  return env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'RETIRE_LEGACY_FEATURES'; });
}

/** 停用動作會碰到的一切（比較「一格都沒有寫」）。 */
function retireSnapshot(env) {
  const g = grid(env);
  return {
    config: JSON.stringify(env.sandbox.readSheet('Config')),
    audit: JSON.stringify(env.sandbox.readSheet('AuditLog')),
    errors: JSON.stringify(env.sandbox.readSheet('ErrorLog')),
    weeks: JSON.stringify(env.sandbox.readSheet('BulletinWeeks')),
    grid: JSON.stringify(g.__data) + JSON.stringify(g.__notes) + g.__hidden + JSON.stringify(g.__protections),
    triggers: JSON.stringify(handlersOf(env)),
    form: JSON.stringify(env.form.__settings)
  };
}

test('R4-1 三處同一份觸發器清單：留着兩個舊觸發器 → 自我檢測、上線前檢查、查看觸發器狀態都報出來；停用之後三處都 🟢', function () {
  const env = makeLegacyEnv({});
  const S = env.sandbox.SELF_CHECK_STATUS_;
  const self = function () { return env.sandbox.runSelfCheck_().items.filter(function (i) { return i.label.indexOf('觸發器：') === 0; }); };
  const goLive = function (label) { return env.sandbox.buildGoLiveChecklist_().filter(function (i) { return i.label === label; })[0]; };
  const statusDialog = function () {
    env.store.alerts = [];
    env.sandbox.menuShowTriggerStatus_();
    return env.store.alerts[0];
  };

  const before = self();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(before.map(function (i) { return i.label + i.status; }))), [
    '觸發器：自動寄送' + S.GREEN, '觸發器：Config 人手改動稽核' + S.GREEN,
    '觸發器：季度填寫表對帳（已停用）' + S.YELLOW, '觸發器：講員表格提交（已停用）' + S.YELLOW
  ]);
  assert.ok(before[2].message.indexOf('季度工具 ▸ 停用舊功能（季度填寫表、講員表格）') !== -1, before[2].message);
  assert.strictEqual(goLive('上線前：星期一觸發器').status, S.GREEN);
  const other = goLive('上線前：其他觸發器');
  assert.strictEqual(other.status, S.YELLOW);
  assert.ok(other.message.indexOf('季度填寫表對帳（已停用）') !== -1 && other.message.indexOf('講員表格提交（已停用）') !== -1, other.message);
  const dialog = statusDialog();
  assert.strictEqual(dialog.title, '查看觸發器狀態（共 4 個）');
  assert.ok(dialog.message.indexOf('季度填寫表對帳（已停用）（fillReconcileTrigger_）：預期 0 個，實際 1 個。') !== -1, dialog.message);
  assert.ok(dialog.message.indexOf('Config 人手改動稽核（onFillGridEdit_）：預期 1 個，實際 1 個。') !== -1, dialog.message);
  assertWrittenChinese(assert, '觸發器狀態', [dialog.message, other.message]);

  env.sandbox.menuRetireLegacyFeatures_();
  assert.ok(self().every(function (i) { return i.status === S.GREEN; }), JSON.stringify(self()));
  assert.strictEqual(goLive('上線前：其他觸發器').status, S.GREEN);
  assert.ok(statusDialog().message.indexOf('實際 1 個') !== -1);
  assert.strictEqual(statusDialog().title, '查看觸發器狀態（共 2 個）');
});

test('R4-2 清單以外的觸發器、讀不到清單：兩個檢測與對話框都講出來（讀不到不等於 0 個）', function () {
  const env = makeLegacyEnv({ triggers: ['weeklyBulletinSendTrigger_', 'onFillGridEdit_', 'someoneElsesHandler'] });
  const S = env.sandbox.SELF_CHECK_STATUS_;
  const unknown = env.sandbox.runSelfCheck_().items.filter(function (i) { return i.label === '觸發器：不在預期清單內'; })[0];
  assert.strictEqual(unknown.status, S.YELLOW);
  assert.ok(unknown.message.indexOf('someoneElsesHandler（1 個）') !== -1, unknown.message);
  assert.strictEqual(env.sandbox.buildGoLiveChecklist_().filter(function (i) { return i.label === '上線前：其他觸發器'; })[0].status, S.YELLOW);

  const broken = makeLegacyEnv({});
  broken.sandbox.ScriptApp.getProjectTriggers = function () { throw new Error('未授權'); };
  const items = broken.sandbox.runSelfCheck_().items.filter(function (i) { return i.label.indexOf('觸發器：') === 0; });
  assert.ok(items.length === 4 && items.every(function (i) { return i.status === S.YELLOW && i.message.indexOf('讀不到') !== -1; }), JSON.stringify(items));
  assert.strictEqual(broken.sandbox.buildGoLiveChecklist_().filter(function (i) { return i.label === '上線前：星期一觸發器'; })[0].status, S.YELLOW);

  const before = retireSnapshot(broken);
  broken.sandbox.menuRetireLegacyFeatures_();
  assert.deepStrictEqual(retireSnapshot(broken), before, '讀不到觸發器清單 → 整次不做');
  assert.ok(broken.store.alerts[0].message.indexOf('讀不到觸發器清單') !== -1, broken.store.alerts[0].message);
});

test('R4-3 停用舊功能（選單，答「是」）：只拆兩個舊觸發器；Fill_ 內容不改、加註解、隱藏、設系統保護；講員表格停止收件；Config 移轉；逐步 AuditLog；預覽項數等於實際', function () {
  const env = makeLegacyEnv({});
  const weeksBefore = JSON.stringify(env.sandbox.readSheet('BulletinWeeks'));
  const gridBefore = JSON.stringify(grid(env).__data);
  env.sandbox.menuRetireLegacyFeatures_();

  const preview = env.store.alerts[0];
  assert.strictEqual(preview.buttons, 'YES_NO');
  ['以下 6 項會停用', '拆走「季度填寫表對帳（已停用）」（fillReconcileTrigger_）1 個', '拆走「講員表格提交（已停用）」（onSpeakerFormSubmit_）1 個',
    '「自動寄送」與「Config 人手改動稽核」兩個觸發器不會動', 'Fill_' + QUARTER_ID + '：A1 加註解、隱藏、設系統保護',
    '【講員表格】停止收件', '講員資料改為在內容表「崇拜程序」填寫，請聯絡幹事。',
    'CONTENT_SHEET_INVITE_GROUPS：「CC,DB,ADMIN,IT」→「CC,DB,ADMIN,IT,WORSHIP」',
    '移走「宣召=幹事」', '加上「崇拜程序=講員、領詩、幹事」'
  ].forEach(function (piece) { assert.ok(preview.message.indexOf(piece) !== -1, '預覽缺少：' + piece + '\n' + preview.message); });
  assertWrittenChinese(assert, '停用舊功能預覽', [preview.message]);

  assert.deepStrictEqual(handlersOf(env), ['onFillGridEdit_', 'weeklyBulletinSendTrigger_']);
  const g = grid(env);
  assert.strictEqual(JSON.stringify(g.__data), gridBefore, 'Fill_ 內容一格都不改');
  assert.ok(g.getRange(1, 1).getNote().indexOf('季度填寫表已停用（2026-10）') === 0, g.getRange(1, 1).getNote());
  assert.strictEqual(g.isSheetHidden(), true);
  assert.deepStrictEqual(g.__protections.map(function (p) { return p.description; }), ['週報系統：系統維護用工作表，請勿人手編輯']);
  assert.strictEqual(env.sheets['Fill_' + QUARTER_ID], g, '不刪分頁');
  assert.strictEqual(env.form.__settings.acceptingResponses, false);
  assert.strictEqual(env.form.__settings.closedMessage, '講員資料改為在內容表「崇拜程序」填寫，請聯絡幹事。');
  assert.strictEqual(env.forms.forms.length, 1, '不刪表格、不建新表格');
  assert.strictEqual(env.sandbox.getConfig('CONTENT_SHEET_INVITE_GROUPS'), 'CC,DB,ADMIN,IT,WORSHIP');
  assert.strictEqual(env.sandbox.getConfig('CONTENT_SHEET_OWNERS'), '崇拜程序=講員、領詩、幹事,家事報告=幹事,代禱事項=堂委,團契聚會=堂委,財政報告=執事,崇拜人數=幹事');
  assert.strictEqual(JSON.stringify(env.sandbox.readSheet('BulletinWeeks')), weeksBefore, '週報一格都不寫');

  const audit = retireAudit(env);
  assert.strictEqual(audit.length, 6, '預覽講 6 項，AuditLog 亦是 6 行');
  const result = env.store.alerts[1];
  assert.ok(result.message.indexOf('已完成 6 項') !== -1, result.message);
  assert.strictEqual(result.message.indexOf('失敗'), -1);
  assert.strictEqual(env.sandbox.readSheet('ErrorLog').length, 0);
  assertWrittenChinese(assert, '停用舊功能結果', [result.message]);
});

test('R4-4 冪等：第二次只見「沒有需要停用的項目」，不問「是／否」，一格都不寫', function () {
  const env = makeLegacyEnv({ answers: ['YES', 'YES'] });
  env.sandbox.menuRetireLegacyFeatures_();
  const before = retireSnapshot(env);
  env.store.alerts = [];
  env.sandbox.menuRetireLegacyFeatures_();
  assert.deepStrictEqual(retireSnapshot(env), before);
  assert.strictEqual(env.store.alerts.length, 1);
  assert.strictEqual(env.store.alerts[0].buttons, 'OK');
  assert.ok(env.store.alerts[0].message.indexOf('沒有需要停用的項目') !== -1, env.store.alerts[0].message);
  assert.strictEqual(env.sandbox.planRetireLegacy_().changeCount, 0);
});

test('R4-5 答「否」→ 一格都不寫', function () {
  const env = makeLegacyEnv({ answers: ['NO'] });
  const before = retireSnapshot(env);
  env.sandbox.menuRetireLegacyFeatures_();
  assert.deepStrictEqual(retireSnapshot(env), before);
  assert.ok(env.store.alerts[1].message.indexOf('已取消，一格都沒有寫') !== -1);
});

test('R4-6 其中一步失敗（表格開不到）→ 其餘步驟照做、ErrorLog 有一行、結果講明；處理好之後再按一次只補做那一步', function () {
  const env = makeLegacyEnv({ answers: ['YES', 'YES'], formOptions: { failOpen: true } });
  env.sandbox.menuRetireLegacyFeatures_();
  const preview = env.store.alerts[0].message;
  assert.ok(preview.indexOf('現時查不到表格狀態') !== -1, preview);
  assert.deepStrictEqual(handlersOf(env), ['onFillGridEdit_', 'weeklyBulletinSendTrigger_'], '其餘步驟照做');
  assert.strictEqual(grid(env).isSheetHidden(), true);
  const errors = env.sandbox.readSheet('ErrorLog').filter(function (r) { return r.ERROR_CODE === 'RETIRE_LEGACY_STEP_FAILED'; });
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0].MESSAGE.indexOf('講員表格停止收件') !== -1, errors[0].MESSAGE);
  const result = env.store.alerts[1].message;
  assert.ok(result.indexOf('已完成 5 項') !== -1 && result.indexOf('失敗 1 項') !== -1, result);
  assert.strictEqual(retireAudit(env).length, 5, '失敗那一步不寫 AuditLog');

  env.forms.setOption('failOpen', false);
  env.store.alerts = [];
  env.sandbox.menuRetireLegacyFeatures_();
  assert.ok(env.store.alerts[0].message.indexOf('以下 1 項會停用') !== -1, env.store.alerts[0].message);
  assert.strictEqual(env.form.__settings.acceptingResponses, false);
  assert.strictEqual(retireAudit(env).length, 6);
});

test('R4-7 Config 移轉：人手改過的值照樣保留，只加缺的組別、只動宣召／浸禮合堂／崇拜程序三項；空白或沒有這個鍵就不動', function () {
  const sb = makeFillEnv({}).sandbox;
  const invite = sb.planRetireInviteGroupsChange_('CC，DB', 'ADMIN,WORSHIP,CC,WORSHIP');
  assert.strictEqual(invite.newValue, 'CC,DB,ADMIN,WORSHIP');
  assert.strictEqual(sb.planRetireInviteGroupsChange_('CC,DB,ADMIN,IT,WORSHIP', 'ADMIN,CC,DB,IT,WORSHIP'), null, '已經齊');
  assert.strictEqual(sb.planRetireInviteGroupsChange_('', 'WORSHIP'), null, '空白＝刻意清走，不動');
  assert.strictEqual(sb.planRetireInviteGroupsChange_(null, 'WORSHIP'), null, '沒有這個鍵 → 由初始化種新預設值');

  const owners = sb.planRetireOwnersChange_('家事報告=甲,崇拜程序=乙,浸禮合堂=丙,宣召=丁,打錯了');
  assert.strictEqual(owners.newValue, '家事報告=甲,崇拜程序=乙,打錯了', '已有崇拜程序就不加；格式不符的原樣保留');
  assert.strictEqual(sb.planRetireOwnersChange_('崇拜程序=乙,家事報告=甲'), null);
  assert.strictEqual(sb.planRetireOwnersChange_(''), null);
  assert.strictEqual(sb.planRetireOwnersChange_(null), null);
  assertWrittenChinese(assert, 'Config 移轉說明', [invite.summary, owners.summary]);
});

test('R4-8 DEFAULTS 同步：舊預設值移轉之後剛好等於新的 DEFAULTS（新舊安裝結果一樣）', function () {
  const sb = makeFillEnv({}).sandbox;
  const def = function (k) { return sb.defaultConfigValueFor_(k); };
  assert.strictEqual(sb.planRetireInviteGroupsChange_(OLD_DEFAULT_INVITE_GROUPS, def('FILL_INVITE_GROUPS')).newValue, def('CONTENT_SHEET_INVITE_GROUPS'));
  assert.strictEqual(sb.planRetireOwnersChange_(OLD_DEFAULT_OWNERS).newValue, def('CONTENT_SHEET_OWNERS'));
  assert.strictEqual(sb.planRetireOwnersChange_(def('CONTENT_SHEET_OWNERS')), null, '新預設值不用再移轉');
  assert.strictEqual(sb.planRetireInviteGroupsChange_(def('CONTENT_SHEET_INVITE_GROUPS'), def('FILL_INVITE_GROUPS')), null);
});

test('R4-9 Fill_ 的 A1 本來已有註解 → 停用註解加在前面，原有的保留', function () {
  const env = makeLegacyEnv({});
  grid(env).getRange(1, 1).setNote('原有的群組說明');
  env.sandbox.menuRetireLegacyFeatures_();
  const note = grid(env).getRange(1, 1).getNote();
  assert.ok(note.indexOf('季度填寫表已停用（2026-10）') === 0 && note.indexOf('原有的群組說明') !== -1, note);
});

test('R4-11（審查 F7）Config 移轉只做一次：之後幹事刻意拿走 WORSHIP，再因為別的原因（Fill_ 被取消隱藏）按一次 → 只補隱藏，WORSHIP 不會被加回去', function () {
  const env = makeLegacyEnv({ answers: ['YES', 'YES'] });
  env.sandbox.menuRetireLegacyFeatures_();
  assert.ok(String(env.sandbox.getConfig('CONTENT_SHEET_INVITE_GROUPS')).indexOf('WORSHIP') !== -1, '第一次照常移轉');
  env.sandbox.setConfig('CONTENT_SHEET_INVITE_GROUPS', OLD_DEFAULT_INVITE_GROUPS, '人手拿走 WORSHIP');
  grid(env).showSheet();
  env.store.alerts = [];
  env.sandbox.menuRetireLegacyFeatures_();
  const preview = env.store.alerts[0].message;
  assert.strictEqual(preview.indexOf('【Config】'), -1, preview);
  assert.ok(preview.indexOf('隱藏') !== -1, preview);
  assert.strictEqual(env.sandbox.getConfig('CONTENT_SHEET_INVITE_GROUPS'), OLD_DEFAULT_INVITE_GROUPS, '人手的改動保留');
  assert.strictEqual(grid(env).isSheetHidden(), true);
});

test('R4-12（審查 F10）查看觸發器狀態：講明只計目前帳戶自己安裝的觸發器', function () {
  const env = makeLegacyEnv({});
  const status = env.sandbox.buildTriggerStatusLines_(env.sandbox.inspectProjectTriggers_());
  const text = Array.from(status.lines).join('\n');
  assert.ok(text.indexOf('只計你這個帳戶自己安裝的觸發器') !== -1, text);
  assertWrittenChinese(assert, '觸發器狀態', text);
});

test('R4-10 接線：只由選單「季度工具 ▸ 停用舊功能」觸發；初始化工作表、星期一觸發器、任何其他檔案都不會呼叫它', function () {
  const store = {};
  const env = makeFillEnv({ ui: recordingUi(store) });
  env.sandbox.onOpen();
  const item = flattenMenu(store.top).filter(function (i) { return i.fn === 'menuRetireLegacyFeatures_'; });
  assert.strictEqual(item.length, 1);
  assert.strictEqual(item[0].parent, '季度工具');
  assert.strictEqual(item[0].label, '停用舊功能（季度填寫表、講員表格）');
  const dir = path.join(__dirname, '..', 'src');
  fs.readdirSync(dir).filter(function (f) { return /\.gs$/.test(f) && f !== 'RetireLegacy.gs'; }).forEach(function (f) {
    const code = readSrc('src/' + f).split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
    assert.strictEqual(code.indexOf('applyRetireLegacy_('), -1, f + ' 不可以呼叫 applyRetireLegacy_()');
  });
});

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
