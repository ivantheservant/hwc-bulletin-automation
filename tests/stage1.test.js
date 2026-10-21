#!/usr/bin/env node
/**
 * tests/stage1.test.js
 *
 * 第二批階段 1 的回歸測試：
 *   1. 獻花欄位旁邊的職事表提示（後端算名字、前端挑句子）。
 *   2. Word 每個主日只保留一份最新版、放在季度子資料夾、記進 DOC_ID。
 *   3. 填寫介面的「最新 Word」連結。
 *
 * 前端函式用「BEGIN／END 標記」從 Script.html 抽出來，在假 DOM 上真的執行；
 * 後端走真正的入口 `apiLoadWeek()`，不是直接呼叫內部函式。
 *
 * 執行方式：node tests/stage1.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeFillEnv, QUARTER_ID, SERVICE_DATES } = require('./helpers/fillEnv');
const { makeFakeDriveApp, makeFakeUtilities, buildFakeDocx } = require('./helpers/fakeDrive');
const fx = require('./fixtures/docxXml');
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
    console.log('    ' + err.message);
  }
}

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function extract(js, name) {
  const start = js.indexOf('// BEGIN ' + name);
  const end = js.indexOf('// END ' + name);
  assert.ok(start !== -1 && end !== -1, 'Script.html 內找不到 ' + name + ' 區段標記');
  return js.slice(start, end);
}

const D = '2027-11-07';
const D_NEXT = '2027-11-14';

/** 職事表多一個 FLOWER 崗位，本週與下週各有一位。 */
function flowerRosterOptions(thisName, nextName) {
  const assignments = [];
  if (thisName !== null) {
    assignments.push({
      QuarterID: QUARTER_ID, VersionNo: 3, ServiceDate: D, PostID: 'FLOWER',
      SlotIndex: 1, PersonID: 'P9002', PersonNameSnapshot: thisName, AssignSource: 'AUTO', Locked: false
    });
  }
  if (nextName !== null) {
    assignments.push({
      QuarterID: QUARTER_ID, VersionNo: 3, ServiceDate: D_NEXT, PostID: 'FLOWER',
      SlotIndex: 1, PersonID: 'P9003', PersonNameSnapshot: nextName, AssignSource: 'AUTO', Locked: false
    });
  }
  return {
    withGrid: false,
    rosterAssignments: assignments,
    rosterPosts: [
      { PostID: 'FLOWER', PostName_TC: '獻花', SlotCount: 1, Frequency: 'WEEKLY', AutoGenerate: true, DisplayOrder: 90, Active: true, EmptyDisplay: 'PENDING' }
    ]
  };
}

// =====================================================================
// 1. 獻花提示
// =====================================================================

console.log('\n獻花提示：後端');

test('rosterFlowerName_：沒有快照、沒找到、沒有崗位、全是空白名字都回空字串', function () {
  const sb = makeFillEnv({ withGrid: false }).sandbox;
  assert.strictEqual(sb.rosterFlowerName_(null), '');
  assert.strictEqual(sb.rosterFlowerName_({ found: false }), '');
  assert.strictEqual(sb.rosterFlowerName_({ found: true, slotsByPost: {} }), '');
  assert.strictEqual(sb.rosterFlowerName_({ found: true, slotsByPost: { FLOWER: [{ personName: '  ' }, {}] } }), '');
});

test('rosterFlowerName_：多位用頓號串起來；有 rosterName 就用它（不用覆寫後的 personName）', function () {
  const sb = makeFillEnv({ withGrid: false }).sandbox;
  const name = sb.rosterFlowerName_({
    found: true,
    slotsByPost: { FLOWER: [{ rosterName: '假甲家庭', personName: '改過的名' }, { personName: '假乙家庭' }] }
  });
  assert.strictEqual(name, '假甲家庭、假乙家庭');
});

test('apiLoadWeek：readOnly.flowerRoster 是本週與下一個主日的職事表獻花名字', function () {
  const sb = makeFillEnv(flowerRosterOptions('假甲家庭', '假乙家庭')).sandbox;
  const r = sb.apiLoadWeek(D);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.data.readOnly.flowerRoster)),
    { thisWeek: '假甲家庭', nextWeek: '假乙家庭' });
  assert.strictEqual(r.data.week.FLOWER_THIS_WEEK || '', '', '表單載入的仍是週報工作表的原值（空白＝跟職事表）');
});

test('apiLoadWeek：週報那一格人手填了 → flowerRoster 仍然是職事表的名字，欄位值不被蓋走', function () {
  const env = makeFillEnv(Object.assign(flowerRosterOptions('假甲家庭', '假乙家庭'), {
    weekRows: [{ SERVICE_DATE: D, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT', FLOWER_THIS_WEEK: '假丙家庭' }]
  }));
  const r = env.sandbox.apiLoadWeek(D);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.data.week.FLOWER_THIS_WEEK, '假丙家庭');
  assert.strictEqual(r.data.readOnly.flowerRoster.thisWeek, '假甲家庭');
});

test('apiLoadWeek：職事表沒有獻花崗位 → flowerRoster 兩個都是空字串', function () {
  const sb = makeFillEnv({ withGrid: false }).sandbox;
  const r = sb.apiLoadWeek(D);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.data.readOnly.flowerRoster)), { thisWeek: '', nextWeek: '' });
});

test('帶入獻花的原有行為不變：週報留空 → 模型用職事表名字；人手填了就不動', function () {
  const sb = makeFillEnv(flowerRosterOptions('假甲家庭', '假乙家庭')).sandbox;
  const model = sb.buildBulletinModel_(D);
  assert.strictEqual(model.flowers.thisWeek, '假甲家庭');
  assert.strictEqual(model.flowers.nextWeek, '假乙家庭');
  assert.strictEqual(model.flowerRoster.thisWeek, '假甲家庭');
});

console.log('\n獻花提示：前端');

function makeFlowerDom(values) {
  const hints = {};
  const inputs = ['FLOWER_THIS_WEEK', 'FLOWER_NEXT_WEEK'].map(function (key) {
    return {
      value: values[key] || '',
      getAttribute: function (attr) { return attr === 'data-field' ? key : null; }
    };
  });
  const document = {
    querySelectorAll: function (sel) { assert.strictEqual(sel, '[data-field]'); return inputs; },
    getElementById: function (id) {
      if (!hints[id]) {
        const node = { id: id, textContent: '' };
        Object.defineProperty(node, 'innerHTML', { set: function () { throw new Error('不可以用 innerHTML 塞資料'); } });
        hints[id] = node;
      }
      return hints[id];
    }
  };
  return { document: document, inputs: inputs, hints: hints };
}

function loadFlowerHint(values) {
  const dom = makeFlowerDom(values || {});
  const ctx = { document: dom.document };
  vm.createContext(ctx);
  vm.runInContext(extract(readSrc('src/ui/Script.html'), 'flower-hint')
    + '\nthis.api = { text: flowerHintText, render: renderFlowerHints };', ctx);
  return { api: ctx.api, dom: dom };
}

test('flowerHintText：留空 → 職事表名字加「留空就用職事表的名字」', function () {
  const t = loadFlowerHint();
  assert.strictEqual(t.api.text('假甲家庭', ''), '職事表：假甲家庭（留空就用職事表的名字）');
  assert.strictEqual(t.api.text('假甲家庭', '   '), '職事表：假甲家庭（留空就用職事表的名字）');
});

test('flowerHintText：改成別的名字 → 「已改，職事表是：X」；改回一樣就回到第一句', function () {
  const t = loadFlowerHint();
  assert.strictEqual(t.api.text('假甲家庭', '假丙家庭'), '已改，職事表是：假甲家庭');
  assert.strictEqual(t.api.text('假甲家庭', '假甲家庭'), '職事表：假甲家庭（留空就用職事表的名字）');
});

test('flowerHintText：職事表沒有名字 → 不顯示提示', function () {
  const t = loadFlowerHint();
  assert.strictEqual(t.api.text('', ''), '');
  assert.strictEqual(t.api.text('', '假丙家庭'), '');
  assert.strictEqual(t.api.text(null, undefined), '');
});

test('renderFlowerHints：兩行提示各按自己那一格的現值，用 textContent', function () {
  const t = loadFlowerHint({ FLOWER_NEXT_WEEK: '假丁家庭' });
  t.api.render({ thisWeek: '假甲家庭', nextWeek: '假乙家庭' });
  assert.strictEqual(t.dom.hints.flowerThisHint.textContent, '職事表：假甲家庭（留空就用職事表的名字）');
  assert.strictEqual(t.dom.hints.flowerNextHint.textContent, '已改，職事表是：假乙家庭');

  // 打字之後再畫一次（input 監聽做的事）
  t.dom.inputs[0].value = '改了';
  t.api.render({ thisWeek: '假甲家庭', nextWeek: '假乙家庭' });
  assert.strictEqual(t.dom.hints.flowerThisHint.textContent, '已改，職事表是：假甲家庭');
});

test('renderFlowerHints：名字當文字顯示，標籤字元不會變成 HTML；沒有資料時清空', function () {
  const t = loadFlowerHint();
  t.api.render({ thisWeek: '<b>甲</b>', nextWeek: '' });
  assert.strictEqual(t.dom.hints.flowerThisHint.textContent, '職事表：<b>甲</b>（留空就用職事表的名字）');
  assert.strictEqual(t.dom.hints.flowerNextHint.textContent, '');
  t.api.render(null);
  assert.strictEqual(t.dom.hints.flowerThisHint.textContent, '');
});

test('接線：載入時與輸入時都會更新提示；Index.html 有兩個提示元素；提示文字是書面語', function () {
  const js = readSrc('src/ui/Script.html');
  const render = js.slice(js.indexOf('function renderReadOnly('), js.indexOf('function renderNextWeekDutyBox('));
  assert.ok(render.indexOf('renderFlowerHints(state.flowerRoster)') !== -1);
  assert.ok(render.indexOf('readOnly.flowerRoster') !== -1);
  const input = js.slice(js.indexOf("document.addEventListener('input'"), js.indexOf('R-038：季度作業'));
  assert.ok(input.indexOf('renderFlowerHints(state.flowerRoster)') !== -1);
  const html = readSrc('src/ui/Index.html');
  assert.ok(html.indexOf('id="flowerThisHint"') !== -1 && html.indexOf('id="flowerNextHint"') !== -1);
  assertWrittenChinese(assert, '獻花提示', [
    '職事表：假甲家庭（留空就用職事表的名字）', '已改，職事表是：假甲家庭'
  ]);
});

// =====================================================================
// 2. Word：每個主日一份最新版、季度子資料夾
// =====================================================================

console.log('\nWord 最新版：存檔');

const TEMPLATE_ID = 'FAKE_TEMPLATE_ID_NORMAL';
const OUTPUT_FOLDER = 'FAKE_OUTPUT_FOLDER';

/**
 * 造一個能真的產生 Word 的環境：假 Drive（含進階服務）、假範本、輸出資料夾。
 * Args:
 *   o {{config:Object=, driveOptions:Object=, uiAlerts:Object[]=, noFolder:boolean=,
 *      weekRows:Object[]=}=}
 */
function makeWordEnv(o) {
  const opts = o || {};
  const drive = makeFakeDriveApp(Object.assign({
    files: { [TEMPLATE_ID]: buildFakeDocx(fx.documentXml(fx.para(fx.run('{{SERMON_TITLE}}')))) },
    folders: { [OUTPUT_FOLDER]: {} }
  }, opts.driveOptions || {}));
  const alerts = opts.uiAlerts || [];
  const utilities = makeFakeUtilities();
  utilities.base64Encode = function (bytes) { return 'B64:' + String(bytes).length; };
  const env = makeFillEnv({
    withGrid: false,
    weekRows: opts.weekRows || [
      { SERVICE_DATE: D, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 1, STATUS: 'DRAFT', SERMON_TITLE: '講題一' },
      { SERVICE_DATE: D_NEXT, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 2, STATUS: 'DRAFT', SERMON_TITLE: '講題二' }
    ],
    config: Object.assign({
      TEMPLATE_FILE_ID_NORMAL: TEMPLATE_ID,
      BULLETIN_OUTPUT_FOLDER_ID: opts.noFolder ? '' : OUTPUT_FOLDER
    }, opts.config || {}),
    driveApp: drive.DriveApp,
    driveAdvanced: drive.Drive,
    utilitiesZip: utilities,
    ui: {
      prompt: function () {
        return { getSelectedButton: function () { return 'OK'; }, getResponseText: function () { return D; } };
      },
      alert: function (title, body) { alerts.push({ title: title, body: body }); return 'OK'; }
    }
  });
  return { sandbox: env.sandbox, drive: drive, alerts: alerts, sheets: env.sheets };
}

function weekRowOf(env, iso) {
  return env.sandbox.readSheet('BulletinWeeks').filter(function (r) {
    return env.sandbox.formatIsoDate_(env.sandbox.normalizeDate_(r.SERVICE_DATE)) === iso;
  })[0];
}

test('outputSubFolderName_：TRUE＋有季度 → 季度 ID；FALSE、沒有季度 → 空字串', function () {
  const sb = makeWordEnv().sandbox;
  assert.strictEqual(sb.outputSubFolderName_('2027T4', 'TRUE'), '2027T4');
  assert.strictEqual(sb.outputSubFolderName_('2027T4', true), '2027T4');
  assert.strictEqual(sb.outputSubFolderName_('2027T4', 'FALSE'), '');
  assert.strictEqual(sb.outputSubFolderName_('', 'TRUE'), '');
  assert.strictEqual(sb.outputSubFolderName_(null, 'TRUE'), '');
});

test('Config 預設：OUTPUT_GROUP_BY_QUARTER 是 TRUE，說明講明每個主日只留一份', function () {
  const sb = makeWordEnv().sandbox;
  const seed = sb.DEFAULTS.filter(function (d) { return d.key === 'OUTPUT_GROUP_BY_QUARTER'; })[0];
  assert.ok(seed, '要有預設值');
  assert.strictEqual(seed.value, 'TRUE');
  assert.ok(seed.note.indexOf('一份最新') !== -1);
  assertWrittenChinese(assert, 'OUTPUT_GROUP_BY_QUARTER 說明', [seed.note]);
});

test('saveBulletinDocx_ 第一次：建季度子資料夾，檔案放進去，檔名不加序號', function () {
  const env = makeWordEnv();
  const r = env.sandbox.saveBulletinDocx_(D);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.file.fileName, D + '_粵語堂週報.docx');
  assert.strictEqual(r.file.folderName, QUARTER_ID);
  assert.strictEqual(r.file.replaced, false);
  assert.strictEqual(env.drive.createdFolders.length, 1);
  assert.strictEqual(env.drive.createdFolders[0].name, QUARTER_ID);
  assert.strictEqual(env.drive.createdFolders[0].parentId, OUTPUT_FOLDER);
  assert.strictEqual(env.drive.listFolderFiles(OUTPUT_FOLDER).length, 0, '不再直接放在輸出資料夾本身');
  assert.strictEqual(env.drive.listFolderFiles(env.drive.createdFolders[0].id).length, 1);
});

test('saveBulletinDocx_ 第二次：原地覆寫同一個檔案，不新增、不加 (2)、不再建子資料夾', function () {
  const env = makeWordEnv();
  const first = env.sandbox.saveBulletinDocx_(D);
  const second = env.sandbox.saveBulletinDocx_(D);
  assert.strictEqual(second.file.fileId, first.file.fileId, '檔案 ID 不變，連結才一直有效');
  assert.strictEqual(second.file.replaced, true);
  assert.strictEqual(second.file.fileName, D + '_粵語堂週報.docx');
  assert.strictEqual(env.drive.createdFiles.length, 1);
  assert.strictEqual(env.drive.createdFolders.length, 1);
  assert.strictEqual(env.drive.updatedFiles.length, 1);
  assert.strictEqual(env.drive.updatedFiles[0].id, first.file.fileId);
  assert.ok(second.file.url.indexOf('https://drive.google.com/file/d/' + first.file.fileId) === 0, second.file.url);
});

test('不同主日各有各的檔案，同在一個季度子資料夾', function () {
  const env = makeWordEnv();
  const a = env.sandbox.saveBulletinDocx_(D);
  const b = env.sandbox.saveBulletinDocx_(D_NEXT);
  assert.notStrictEqual(a.file.fileId, b.file.fileId);
  assert.strictEqual(env.drive.createdFolders.length, 1);
  assert.strictEqual(env.drive.createdFiles.length, 2);
  assert.strictEqual(b.file.fileName, D_NEXT + '_粵語堂週報.docx');
});

test('OUTPUT_GROUP_BY_QUARTER=FALSE：直接放在輸出資料夾，仍然只保留一份', function () {
  const env = makeWordEnv({ config: { OUTPUT_GROUP_BY_QUARTER: 'FALSE' } });
  const first = env.sandbox.saveBulletinDocx_(D);
  const second = env.sandbox.saveBulletinDocx_(D);
  assert.strictEqual(env.drive.createdFolders.length, 0);
  assert.strictEqual(first.file.folderName, '');
  assert.strictEqual(env.drive.listFolderFiles(OUTPUT_FOLDER).length, 1);
  assert.strictEqual(second.file.fileId, first.file.fileId);
});

test('查不到有沒有同名檔案（Drive 進階服務出錯）→ 拋錯，不新建任何東西', function () {
  const env = makeWordEnv({ driveOptions: { failList: true } });
  assert.throws(function () { env.sandbox.saveBulletinDocx_(D); }, /為免建立兩個同名的子資料夾/);
  assert.strictEqual(env.drive.createdFiles.length, 0);
  assert.strictEqual(env.drive.createdFolders.length, 0);
});

test('資料夾內已有多份同名檔案 → 只更新最舊的一份，回報多出來的份數，不刪檔', function () {
  const env = makeWordEnv();
  const first = env.sandbox.saveBulletinDocx_(D);
  // 人手在同一個子資料夾又放了一份同名檔案。
  const sub = env.drive.DriveApp.getFolderById(env.drive.createdFolders[0].id);
  sub.createFile(env.sandbox.Utilities.newBlob('人手放的', 'x', D + '_粵語堂週報.docx'));
  assert.strictEqual(env.drive.createdFiles.length, 2);

  const again = env.sandbox.saveBulletinDocx_(D);
  assert.strictEqual(again.file.fileId, first.file.fileId, '最舊的一份才是系統的');
  assert.strictEqual(again.file.duplicateCount, 1);
  assert.strictEqual(env.drive.createdFiles.length, 2, '沒有刪檔、沒有再新建');
  const lines = env.sandbox.buildGenerateResultDialogLines_(D, again);
  assert.ok(lines.join('\n').indexOf('還有 1 份同名檔案') !== -1, lines.join('\n'));
});

test('選單入口 menuGenerateBulletinDocx_：記下 DOC_ID、寫 AuditLog；再產生一次 DOC_ID 不變，對話框講明已更新', function () {
  const env = makeWordEnv();
  env.sandbox.menuGenerateBulletinDocx_();
  const firstRow = weekRowOf(env, D);
  assert.ok(String(firstRow.DOC_ID || '') !== '', 'DOC_ID 要記下來');
  // 沙箱的 Date 與測試的 Date 不是同一個，用 toString 判斷（同 Invariants.gs）。
  assert.strictEqual(Object.prototype.toString.call(firstRow.LAST_GENERATED_AT), '[object Date]');
  assert.strictEqual(env.drive.createdFiles.length, 1);
  assert.ok(env.alerts[0].body.indexOf('第一次產生，已新建檔案') !== -1, env.alerts[0].body);
  assert.ok(env.alerts[0].body.indexOf('輸出資料夾 ▸ ' + QUARTER_ID) !== -1, env.alerts[0].body);

  env.sandbox.menuGenerateBulletinDocx_();
  const secondRow = weekRowOf(env, D);
  assert.strictEqual(secondRow.DOC_ID, firstRow.DOC_ID);
  assert.strictEqual(env.drive.createdFiles.length, 1, '沒有第二份檔案');
  assert.ok(env.alerts[1].body.indexOf('已更新為最新版') !== -1, env.alerts[1].body);

  const audit = env.sandbox.readSheet('AuditLog').filter(function (r) { return r.ACTION === 'BULLETIN_DOCX_MENU_SAVE'; });
  assert.strictEqual(audit.length, 2);
  assert.strictEqual(audit[0].FIELD, 'DOC_ID');
  assertWrittenChinese(assert, '對話框', [env.alerts[0].body, env.alerts[1].body]);
});

test('整季批次產生仍然走同一條路：每個主日一份，批次跳過已產生的', function () {
  const n = SERVICE_DATES.length;
  const env = makeWordEnv({
    weekRows: SERVICE_DATES.map(function (iso, i) {
      return { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: i + 1, STATUS: 'DRAFT', SERMON_TITLE: '講題' + (i + 1) };
    })
  });
  const summary = env.sandbox.generateQuarterBulletinsBatch_(QUARTER_ID);
  assert.strictEqual(summary.failed, 0, JSON.stringify(summary.results));
  assert.strictEqual(summary.succeeded, n, JSON.stringify(summary.results.map(function (r) { return r.status; })));
  assert.strictEqual(env.drive.createdFolders.length, 1, '整季只有一個季度子資料夾');
  assert.strictEqual(env.drive.createdFiles.length, n);
  const again = env.sandbox.generateQuarterBulletinsBatch_(QUARTER_ID);
  assert.strictEqual(again.succeeded, 0);
  assert.strictEqual(again.skipped, n);
  assert.strictEqual(env.drive.createdFiles.length, n, '批次重跑不新增檔案');
});

console.log('\n填寫介面：下載 Word 與最新 Word 連結');

test('apiLoadWeek：從未存過 → wordFile 是 null', function () {
  const env = makeWordEnv();
  const r = env.sandbox.apiLoadWeek(D);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.data.wordFile, null);
});

test('apiDownloadBulletinDocx（真入口）：下載之餘存一份雲端最新版，apiLoadWeek 隨後帶出連結', function () {
  const env = makeWordEnv();
  const dl = env.sandbox.apiDownloadBulletinDocx(D);
  assert.strictEqual(dl.ok, true, JSON.stringify(dl));
  assert.ok(dl.data.base64.indexOf('B64:') === 0);
  assert.ok(dl.data.wordFile, '要有 wordFile');
  assert.ok(dl.data.wordFile.url.indexOf('https://drive.google.com/file/d/') === 0);
  assert.strictEqual(dl.data.wordFile.fileName, D + '_粵語堂週報.docx');
  assert.strictEqual(dl.data.warnings.filter(function (w) { return String(w.code).indexOf('WORD_') === 0; }).length, 0);
  assert.strictEqual(env.drive.createdFiles.length, 1);

  const loaded = env.sandbox.apiLoadWeek(D);
  assert.strictEqual(loaded.data.wordFile.fileId, dl.data.wordFile.fileId);
  assert.strictEqual(loaded.data.wordFile.url, dl.data.wordFile.url);
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(loaded.data.wordFile.generatedAt) || loaded.data.wordFile.generatedAt !== '',
    '要有產生時間：' + loaded.data.wordFile.generatedAt);

  // 另一個主日不受影響
  assert.strictEqual(env.sandbox.apiLoadWeek(D_NEXT).data.wordFile, null);
  // 再下載一次：同一個檔案
  const dl2 = env.sandbox.apiDownloadBulletinDocx(D);
  assert.strictEqual(dl2.data.wordFile.fileId, dl.data.wordFile.fileId);
  assert.strictEqual(env.drive.createdFiles.length, 1);
});

test('apiDownloadBulletinDocx：沒有設定輸出資料夾 → 照樣下載成功，附警告，不寫 DOC_ID', function () {
  const env = makeWordEnv({ noFolder: true });
  const dl = env.sandbox.apiDownloadBulletinDocx(D);
  assert.strictEqual(dl.ok, true, JSON.stringify(dl));
  assert.strictEqual(dl.data.wordFile, null);
  const w = dl.data.warnings.filter(function (x) { return x.code === 'WORD_NOT_STORED'; });
  assert.strictEqual(w.length, 1);
  assert.strictEqual(String(weekRowOf(env, D).DOC_ID || ''), '');
  assertWrittenChinese(assert, '警告', [w[0].message]);
});

test('apiDownloadBulletinDocx：存雲端失敗 → 照樣下載成功，附警告，不留下半截的 DOC_ID', function () {
  const broken = makeWordEnv({ driveOptions: { failList: true } });
  const dl = broken.sandbox.apiDownloadBulletinDocx(D);
  assert.strictEqual(dl.ok, true, JSON.stringify(dl));
  assert.ok(dl.data.base64.indexOf('B64:') === 0, '手上那份檔案照樣拿得到');
  assert.strictEqual(dl.data.wordFile, null);
  const w = dl.data.warnings.filter(function (x) { return x.code === 'WORD_STORE_FAILED'; });
  assert.strictEqual(w.length, 1, JSON.stringify(dl.data.warnings));
  assert.strictEqual(String(weekRowOf(broken, D).DOC_ID || ''), '');
  assertWrittenChinese(assert, '警告', [w[0].message]);
});

test('apiDownloadBulletinDocx：BulletinWeeks 沒有那一行 → Word 照存，警告講明連結記不下來', function () {
  const env = makeWordEnv({ weekRows: [{ SERVICE_DATE: D_NEXT, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: 2, STATUS: 'DRAFT' }] });
  const dl = env.sandbox.apiDownloadBulletinDocx(D);
  assert.strictEqual(dl.ok, true, JSON.stringify(dl));
  const warn = dl.data.warnings.filter(function (x) { return x.code === 'WORD_NOT_RECORDED'; });
  assert.strictEqual(warn.length, 1, JSON.stringify(dl.data.warnings));
  assert.ok(dl.data.wordFile, '檔案本身存好了');
  assertWrittenChinese(assert, '警告', [warn[0].message]);
});

console.log('\n填寫介面：最新 Word 連結（前端）');

function loadWordFileRegion() {
  const elements = {};
  function makeNode(id) {
    const node = {
      id: id, textContent: '', attrs: {}, classes: new Set(['hidden']),
      classList: {
        add: function (c) { node.classes.add(c); },
        remove: function (c) { node.classes.delete(c); }
      },
      setAttribute: function (k, v) { node.attrs[k] = v; },
      removeAttribute: function (k) { delete node.attrs[k]; }
    };
    Object.defineProperty(node, 'innerHTML', { set: function () { throw new Error('不可以用 innerHTML 塞資料'); } });
    return node;
  }
  const ctx = {
    document: { getElementById: function (id) { return elements[id] || (elements[id] = makeNode(id)); } }
  };
  vm.createContext(ctx);
  vm.runInContext(extract(readSrc('src/ui/Script.html'), 'word-file')
    + '\nthis.api = { render: renderWordFileInfo, message: downloadWordMessage };', ctx);
  return { api: ctx.api, elements: elements };
}

test('renderWordFileInfo：有檔案 → 文字加連結（href、檔名、時間），用 textContent', function () {
  const t = loadWordFileRegion();
  t.api.render({ url: 'https://drive.google.com/file/d/ABC/view', fileName: '2027-11-07_粵語堂週報.docx', generatedAt: '2027-11-05 21:30' });
  assert.strictEqual(t.elements.wordFileInfoText.textContent, '雲端硬碟上的最新 Word（2027-11-05 21:30 產生）：');
  assert.strictEqual(t.elements.wordFileLink.textContent, '2027-11-07_粵語堂週報.docx');
  assert.strictEqual(t.elements.wordFileLink.attrs.href, 'https://drive.google.com/file/d/ABC/view');
  assert.strictEqual(t.elements.wordFileLink.classes.has('hidden'), false);
});

test('renderWordFileInfo：沒有檔案、或網址不是 Drive → 只有文字，連結收起', function () {
  const t = loadWordFileRegion();
  t.api.render({ url: 'https://drive.google.com/file/d/ABC/view', fileName: 'a.docx', generatedAt: '' });
  t.api.render(null);
  assert.ok(t.elements.wordFileInfoText.textContent.indexOf('還沒有這個主日的 Word 檔') !== -1);
  assert.strictEqual(t.elements.wordFileLink.classes.has('hidden'), true);
  assert.strictEqual(t.elements.wordFileLink.attrs.href, undefined);

  t.api.render({ url: 'javascript:alert(1)', fileName: 'a.docx', generatedAt: '' });
  assert.strictEqual(t.elements.wordFileLink.classes.has('hidden'), true, '不是 Drive 網址不畫連結');
  assert.strictEqual(t.elements.wordFileLink.attrs.href, undefined);
});

test('downloadWordMessage：存雲端成功／失敗／沒有設定各說各話，下載本身一律先講已產生', function () {
  const t = loadWordFileRegion();
  const ok = t.api.message({ fileName: 'a.docx', warnings: [], wordFile: { url: 'https://drive.google.com/x' } });
  assert.strictEqual(ok.type, 'info');
  assert.ok(ok.text.indexOf('已產生 a.docx') === 0 && ok.text.indexOf('最新版也已更新') !== -1, ok.text);
  const bad = t.api.message({ fileName: 'a.docx', warnings: [{ code: 'WORD_STORE_FAILED', message: '存檔失敗了' }, { code: 'OTHER', message: '別的' }], wordFile: null });
  assert.strictEqual(bad.type, 'error');
  assert.ok(bad.text.indexOf('已產生 a.docx') === 0 && bad.text.indexOf('存檔失敗了') !== -1 && bad.text.indexOf('別的') === -1, bad.text);
  const none = t.api.message({ fileName: 'a.docx', warnings: [], wordFile: null });
  assert.strictEqual(none.type, 'info');
  assert.strictEqual(none.text.indexOf('最新版也已更新'), -1);
});

test('接線：載入週報與下載完成都會更新連結；Index.html 有連結元素', function () {
  const js = readSrc('src/ui/Script.html');
  const loaded = js.slice(js.indexOf('function onWeekLoaded('), js.indexOf('function renderFillGridLink('));
  assert.ok(loaded.indexOf('renderWordFileInfo(data.wordFile)') !== -1);
  const dl = js.slice(js.indexOf('function downloadWord('), js.indexOf('function triggerBinaryDownload('));
  assert.ok(dl.indexOf('renderWordFileInfo(resp.data.wordFile)') !== -1);
  assert.ok(dl.indexOf('downloadWordMessage(resp.data)') !== -1);
  const html = readSrc('src/ui/Index.html');
  assert.ok(html.indexOf('id="wordFileLink"') !== -1 && html.indexOf('id="wordFileInfoText"') !== -1);
});

console.log('\n演練不可以蓋走最新版 Word');

test('全季流程演練（真入口 runQuarterRehearsal_）：另存獨立副本，不更新這個主日的最新版', function () {
  const env = makeWordEnv({
    weekRows: SERVICE_DATES.map(function (iso, i) {
      return { SERVICE_DATE: iso, QUARTER_ID: QUARTER_ID, WEEK_OF_MONTH: i + 1, STATUS: 'DRAFT', SERMON_TITLE: '講題' + (i + 1) };
    })
  });
  // 先有一份（假設已經被人手修改過的）最新版。
  const latest = env.sandbox.saveBulletinDocx_(SERVICE_DATES[0]);
  assert.strictEqual(env.drive.createdFiles.length, 1);

  const summary = env.sandbox.runQuarterRehearsal_(QUARTER_ID);
  assert.strictEqual(summary.failedSteps.length, 0, JSON.stringify(summary.failedSteps));
  assert.strictEqual(env.drive.updatedFiles.length, 0, '最新版不可以被覆寫');
  assert.strictEqual(env.drive.createdFiles.length, 2, '演練另外存了一份副本');
  assert.notStrictEqual(summary.wordResult.file.fileId, latest.file.fileId);
  assert.strictEqual(env.drive.listFolderFiles(OUTPUT_FOLDER).length, 1, '副本在輸出資料夾本身，與季度子資料夾裏的最新版分開');
});

console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項。');
process.exit(fail === 0 ? 0 : 1);
