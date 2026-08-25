#!/usr/bin/env node
/**
 * tests/monkeyrun.test.js
 *
 * 第 3 層（`src/MonkeyRun.gs`）的回歸測試。
 *
 * ⚠️ 同 tests/selftest.test.js 一樣：這一組只驗得到**骨架**——守門會不會
 * 擋、亂數可不可以重覆、報告有沒有印出「走到這裏的完整步驟」。真正的
 * 價值（隨機走出沒有人想過的狀態）只有在真環境按下去才發生。
 *
 * 這一組最重要的兩條：
 *   - 同一個種子走同一條路（沒有它，紅了也重現不到，整層白費）
 *   - 動作清單裡面**沒有**安裝觸發器／改 Config／寫職事表這些動作
 *
 * 執行方式：node tests/monkeyrun.test.js
 * 離開碼：0＝全部通過　1＝有測試失敗
 */

'use strict';

const assert = require('assert');
const { loadAllSrcFilesInOrder } = require('./helpers/loadGas');
const { makeFakeSheet, makeFakeSpreadsheet } = require('./helpers/fakeSpreadsheet');
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

function deepEq(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
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
        const ss = String(date.getSeconds()).padStart(2, '0');
        if (String(pattern).indexOf('HHmmss') !== -1) return `${y}${mo}${d}${hh}${mi}${ss}`;
        if (String(pattern).indexOf('HH') !== -1) return `${y}-${mo}-${d} ${hh}:${mi}`;
        return `${y}-${mo}-${d}`;
      }
    },
    Session: {
      getScriptTimeZone: function () { return 'Pacific/Auckland'; },
      getActiveUser: function () { return { getEmail: function () { return 'tester@example.com'; } }; }
    },
    CacheService: {},
    HtmlService: {}
  };
}

function makeEnv(options) {
  const o = options || {};
  const boot = loadAllSrcFilesInOrder(baseStubs());

  const cfg = {};
  boot.DEFAULTS.forEach(function (d) { cfg[d.key] = d.value; });
  Object.assign(cfg, o.config || {});

  function ownSheet(sheetId, rows) {
    const def = boot.COLUMNS[sheetId];
    return makeFakeSheet(def.headers, def.keys, rows || []);
  }

  const sheets = {};
  Object.keys(boot.SHEETS).forEach(function (id) { sheets[boot.SHEETS[id]] = ownSheet(id, []); });
  sheets.Config = ownSheet('CONFIG', Object.keys(cfg).map(function (k) {
    return { KEY: k, VALUE: cfg[k], NOTE: '', EDITABLE: true };
  }));
  sheets.BulletinWeeks = ownSheet('BULLETIN_WEEKS', o.weekRows || []);
  sheets.MonkeyLog = ownSheet('MONKEY_LOG', o.monkeyLog || []);
  sheets.MonkeyState = ownSheet('MONKEY_STATE', o.monkeyState || []);

  const sandbox = loadAllSrcFilesInOrder(Object.assign({}, baseStubs(), {
    SpreadsheetApp: {
      getActiveSpreadsheet: function () { return makeFakeSpreadsheet(sheets); },
      openById: function () { throw new Error('這一組測試不連職事表'); },
      ProtectionType: { SHEET: 'SHEET' },
      getUi: function () {
        return {
          createMenu: function () {
            const m = {
              addItem: function () { return m; }, addSeparator: function () { return m; },
              addSubMenu: function () { return m; }, addToUi: function () { return m; }
            };
            return m;
          },
          alert: function () { return 'OK'; },
          prompt: function () {
            return { getSelectedButton: function () { return 'CANCEL'; }, getResponseText: function () { return ''; } };
          },
          ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL' }, Button: { OK: 'OK', CANCEL: 'CANCEL' }
        };
      }
    }
  }));

  return { sandbox: sandbox, sheets: sheets, boot: boot };
}

// =====================================================================
// 亂數：同一個種子走同一條路
// =====================================================================

test('monkeyRandom_：同一個種子產生同一串數字（沒有它，紅了也重現不到）', function () {
  const env = makeEnv({});
  const a = env.sandbox.monkeyRandom_(12345);
  const b = env.sandbox.monkeyRandom_(12345);

  const seqA = [];
  const seqB = [];
  for (let i = 0; i < 30; i++) {
    seqA.push(a.nextInt(7));
    seqB.push(b.nextInt(7));
  }
  deepEq(seqA, seqB, '同一個種子必須走同一條路');
});

test('monkeyRandom_：不同種子產生不同的串（否則種子形同虛設）', function () {
  const env = makeEnv({});
  const a = env.sandbox.monkeyRandom_(1);
  const b = env.sandbox.monkeyRandom_(999);

  const seqA = [];
  const seqB = [];
  for (let i = 0; i < 30; i++) {
    seqA.push(a.nextInt(7));
    seqB.push(b.nextInt(7));
  }
  assert.notStrictEqual(JSON.stringify(seqA), JSON.stringify(seqB));
});

test('monkeyRandom_：nextInt(n) 一定落在 0 至 n-1 之間', function () {
  const env = makeEnv({});
  const rng = env.sandbox.monkeyRandom_(42);
  for (let i = 0; i < 500; i++) {
    const v = rng.nextInt(5);
    assert.ok(v >= 0 && v <= 4, '越界：' + v);
    assert.strictEqual(v, Math.floor(v), '要是整數：' + v);
  }
});

test('monkeyRandom_：nextInt(1) 永遠回 0，不會除以零或回 NaN', function () {
  const env = makeEnv({});
  const rng = env.sandbox.monkeyRandom_(7);
  for (let i = 0; i < 20; i++) assert.strictEqual(rng.nextInt(1), 0);
  assert.strictEqual(env.sandbox.monkeyRandom_(7).nextInt(0), 0, 'n=0 要當成 1 處理，不可以回 NaN');
});

// =====================================================================
// 動作清單：靠「根本沒有這個選項」，不是靠執行時擋
// =====================================================================

test('動作清單：沒有安裝觸發器／改 Config／寫職事表／碰正式 master 這幾種動作', function () {
  const env = makeEnv({});
  const actions = env.sandbox.monkeyActions_();
  const text = actions.map(function (a) { return a.id + ' ' + a.label; }).join('\n');

  ['觸發器', 'Trigger', 'TRIGGER'].forEach(function (banned) {
    assert.ok(text.indexOf(banned) === -1, '動作清單不可以有觸發器相關的動作：' + text);
  });
  ['設定', 'CONFIG'].forEach(function (banned) {
    assert.ok(text.indexOf(banned) === -1, '動作清單不可以有改 Config 的動作：' + text);
  });
  assert.ok(text.indexOf('職事表') === -1, '動作清單不可以有寫職事表的動作：' + text);
});

test('動作清單：每一個都有 id、label、available、run', function () {
  const env = makeEnv({});
  env.sandbox.monkeyActions_().forEach(function (a) {
    const actionId = a.id;
    assert.ok(String(actionId).length > 0);
    assert.ok(String(a.label).length > 0, actionId + ' 沒有標籤');
    assert.strictEqual(typeof a.available, 'function', actionId + ' 沒有 available()');
    assert.strictEqual(typeof a.run, 'function', actionId + ' 沒有 run()');
  });
});

test('動作清單：動作標籤是書面語繁體中文', function () {
  const env = makeEnv({});
  const labels = env.sandbox.monkeyActions_().map(function (a) { return a.label; }).join('\n');
  assertWrittenChinese(assert, '亂行機動作標籤', labels);
});

test('動作清單：空季度時只有「建立本季空白週報」與不需要週報的動作', function () {
  const env = makeEnv({});
  const actions = env.sandbox.monkeyActions_();
  const emptyState = {
    weekCount: 0, announcementCount: 0, hasContentFolder: false,
    hasContentSheet: false, hasSandboxMaster: false, canRenderDocx: false, hasRecipients: false
  };
  const available = actions.filter(function (a) { return a.available(emptyState); })
    .map(function (a) { return a.id; });

  deepEq(available, ['CREATE_WEEKS'], '空季度、甚麼都未設定時只應該有一個合法動作');
});

test('動作清單：沒有沙盒 master 檔案時，發佈動作不會出現（絕對不碰正式那一個）', function () {
  const env = makeEnv({});
  const state = {
    weekCount: 5, announcementCount: 0, hasContentFolder: false,
    hasContentSheet: false, hasSandboxMaster: false, canRenderDocx: false, hasRecipients: false
  };
  const available = env.sandbox.monkeyActions_()
    .filter(function (a) { return a.available(state); })
    .map(function (a) { return a.id; });

  assert.ok(available.indexOf('PUBLISH') === -1,
    '沒有沙盒 master 就不可以有發佈動作，否則會覆寫正式那一個：' + available.join('、'));
});

test('動作清單：沒有收件人時，寄出動作不會出現', function () {
  const env = makeEnv({});
  const state = {
    weekCount: 5, announcementCount: 0, hasContentFolder: false,
    hasContentSheet: false, hasSandboxMaster: false, canRenderDocx: false, hasRecipients: false
  };
  const available = env.sandbox.monkeyActions_()
    .filter(function (a) { return a.available(state); })
    .map(function (a) { return a.id; });
  assert.ok(available.indexOf('SEND_DRY_RUN') === -1, available.join('、'));
});

// =====================================================================
// 守門
// =====================================================================

test('守門：DRY_RUN=FALSE → 一步都不走', function () {
  const env = makeEnv({ config: { DRY_RUN: 'FALSE' } });
  const summary = env.sandbox.runMonkey_({ steps: 10 });

  assert.strictEqual(summary.ok, false);
  deepEq(summary.steps, []);
  assert.strictEqual(env.sheets.MonkeyLog.getLastRow(), 2, 'MonkeyLog 不應該多任何一行');
});

test('守門：monkeyAssertDryRun_ 在 DRY_RUN 變成 FALSE 時拋錯', function () {
  const env = makeEnv({ config: { DRY_RUN: 'FALSE' } });
  assert.throws(function () { env.sandbox.monkeyAssertDryRun_(); }, /亂行機中止/);
});

test('守門：monkeyAssertDryRun_ 在 DRY_RUN=TRUE 時不拋錯', function () {
  const env = makeEnv({});
  assert.doesNotThrow(function () { env.sandbox.monkeyAssertDryRun_(); });
});

test('守門：沙盒季度撞正只讀季度 → 一步都不走', function () {
  const env = makeEnv({
    config: { SELFTEST_QUARTER_ID: '2027T4', SELFTEST_ROSTER_QUARTER_ID: '2027T4' }
  });
  const summary = env.sandbox.runMonkey_({ steps: 5 });
  assert.strictEqual(summary.ok, false);
  assert.ok(summary.message.indexOf('真實資料會被清走') !== -1, summary.message);
});

// =====================================================================
// 報告
// =====================================================================

function fakeSummary(overrides) {
  return Object.assign({
    ok: true,
    runId: 'MK20281001000000',
    seed: 987654321,
    requestedSteps: 50,
    steps: [
      {
        stepNo: 1, availableIds: ['CREATE_WEEKS'], chosenId: 'CREATE_WEEKS',
        chosenLabel: '建立本季空白週報', result: 'OK', detail: '建立了 13 行',
        invariantStatus: '全部通過（3 條驗證不到）', invariantFailures: [],
        pathSoFar: '建立本季空白週報'
      },
      {
        stepNo: 2, availableIds: ['EDIT_FIELDS', 'IMPORT_CONTENT'], chosenId: 'IMPORT_CONTENT',
        chosenLabel: '從內容表匯入', result: 'OK', detail: '新增 4',
        invariantStatus: '不成立：I08', pathSoFar: '建立本季空白週報 → 從內容表匯入',
        invariantFailures: [{
          id: 'I08', expected: '0 項改動', actual: '4 項改動',
          evidence: '再匯入應為 0 改動，實際 4 行'
        }]
      }
    ],
    failedStep: null,
    stoppedForTime: false,
    // 第三輪新增：累計進度、覆蓋統計、防打轉閘。
    stoppedForNoProgress: false,
    stepsDoneBefore: 0,
    totalStepsDone: 2,
    targetSteps: 50,
    status: 'PAUSED',
    resumed: false,
    noProgressLimit: 5,
    coverage: [
      { id: 'CREATE_WEEKS', label: '建立本季空白週報', chosen: 1, notApplicableReasons: [] },
      { id: 'IMPORT_CONTENT', label: '從內容表匯入', chosen: 1, notApplicableReasons: [] },
      { id: 'EDIT_FIELDS', label: '經填寫介面改幾格', chosen: 0, notApplicableReasons: [] },
      { id: 'PUBLISH', label: '發佈（沙盒 master 檔案）', chosen: 0,
        notApplicableReasons: ['Config 的 SELFTEST_MASTER_PDF_FILE_ID 是空的'] }
    ]
  }, overrides || {});
}


// =====================================================================
// 第三輪：亂數產生器、續跑、覆蓋統計、防打轉閘
// =====================================================================

// ⚠️ 這一條守的是實測出來的缺陷（docs/已知bug類型.md 事故三十五）：
//    舊版是模 2^32 的線性同餘 ＋ `state % bound`，而模 2 的冪的 LCG
//    **低位元週期極短**，`% bound` 取的正是低位元。實測 nextInt(8) 是一個
//    固定的八循環 1,4,3,6,5,0,7,2 不停重覆。
//
//    ⚠️ 用「分佈」去驗是驗不出來的——數 100000 次每個都是 12500。
//    要驗的是**序列**。
test('亂數：nextInt(2) 不可以是嚴格交替（舊版 LCG 的低位元週期）', function () {
  const env = makeEnv({});
  const r = env.sandbox.monkeyRandom_(922896898);
  const seq = [];
  for (let i = 0; i < 20; i++) seq.push(r.nextInt(2));

  let alternating = true;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === seq[i - 1]) { alternating = false; break; }
  }
  assert.strictEqual(alternating, false,
    'nextInt(2) 嚴格交替代表低位元只有週期 2：' + seq.join(','));
});

test('亂數：nextInt(8) 不可以有週期 8 的循環', function () {
  const env = makeEnv({});
  const r = env.sandbox.monkeyRandom_(922896898);
  const seq = [];
  for (let i = 0; i < 24; i++) seq.push(r.nextInt(8));

  const first = seq.slice(0, 8).join(',');
  const second = seq.slice(8, 16).join(',');
  const third = seq.slice(16, 24).join(',');
  assert.ok(!(first === second && second === third),
    '頭三段完全相同代表週期 8 的固定循環：' + seq.join(','));
});

// ⚠️ 種子取自時間戳記，連續幾次執行的種子只差幾百。舊版之下這幾個種子
//    只是同一個循環的旋轉——三次「不同」的執行其實走同一條路。
test('亂數：相近的種子不可以只是同一個序列的旋轉', function () {
  const env = makeEnv({});
  function draw(seed) {
    const r = env.sandbox.monkeyRandom_(seed);
    const out = [];
    for (let i = 0; i < 16; i++) out.push(r.nextInt(8));
    return out;
  }
  const a = draw(922896898).join(',');
  const b = draw(923417060).join(',');
  // 旋轉檢查：b 是不是 a 的某一個旋轉（用 a+a 包含 b 判斷）。
  const doubled = draw(922896898).concat(draw(922896898)).join(',');
  assert.ok(doubled.indexOf(b) === -1, 'b 是 a 的旋轉：\n  a=' + a + '\n  b=' + b);
});

test('亂數：8 個候選、25 步，零次被揀中的動作應該很少（舊版是 3 個）', function () {
  const env = makeEnv({});
  let totalZero = 0;
  const runs = 200;
  for (let k = 0; k < runs; k++) {
    const r = env.sandbox.monkeyRandom_(1000000 + k * 137);
    const counts = new Array(8).fill(0);
    for (let i = 0; i < 25; i++) {
      counts[r.nextInt(8)]++;
      r.nextInt(5); // 模擬動作內部也會抽亂數
    }
    totalZero += counts.filter(function (c) { return c === 0; }).length;
  }
  const avg = totalZero / runs;
  assert.ok(avg < 1.5, '平均每次執行有 ' + avg.toFixed(2) + ' 個動作零次，太多');
});

// ⚠️ 這一條是 prompt 的自我檢驗：同一個種子由頭跑滿 20 步，與分三批續跑
//    到 20 步，**揀中的動作序列必須完全相同**。做不到的話，〔繼續亂行〕
//    就不是續跑。
test('續跑等價：一次過 20 步 vs 分三批續跑，序列完全相同', function () {
  const env = makeEnv({});

  const once = env.sandbox.monkeyRandom_(20281001);
  const seqOnce = [];
  for (let i = 0; i < 20; i++) seqOnce.push(once.nextInt(8));

  const seqBatched = [];
  let saved = null;
  [7, 6, 7].forEach(function (n) {
    const r = env.sandbox.monkeyRandom_(20281001, saved);
    for (let i = 0; i < n; i++) seqBatched.push(r.nextInt(8));
    saved = r.state();
  });

  deepEq(seqBatched, seqOnce, '分批續跑走的路必須與一次過跑完全相同');
});

test('亂數：state() 拿得到內部狀態，而且與種子不同（否則續不到）', function () {
  const env = makeEnv({});
  const r = env.sandbox.monkeyRandom_(12345);
  const before = r.state();
  r.nextInt(8);
  assert.notStrictEqual(r.state(), before, '抽過一次之後內部狀態要變');
  assert.strictEqual(r.seed, 12345, '種子本身不變');
});

// =====================================================================
// 續跑狀態
// =====================================================================

function monkeyStateRow(overrides) {
  return Object.assign({
    RUN_ID: 'MK20281001000000', SEED: '987654321', TARGET_STEPS: 20, STEPS_DONE: 7,
    RNG_STATE: '123456789', STATUS: 'PAUSED',
    STARTED_AT: '2028-10-01', UPDATED_AT: '2028-10-01', NOTES: ''
  }, overrides || {});
}

test('沒有任何續跑紀錄 → monkeyLatestPausedState_ 回 null', function () {
  const env = makeEnv({});
  assert.strictEqual(env.sandbox.monkeyLatestPausedState_(), null);
});

test('最後一行是 DONE → 回 null（不可以往上找更舊的 PAUSED）', function () {
  // ⚠️ 更舊那一輪的沙盒狀態早就被後來那一輪改過，接住走沒有意義。
  const env = makeEnv({
    monkeyState: [
      monkeyStateRow({ RUN_ID: 'MK_OLD', STATUS: 'PAUSED' }),
      monkeyStateRow({ RUN_ID: 'MK_NEW', STATUS: 'DONE', STEPS_DONE: 20 })
    ]
  });
  assert.strictEqual(env.sandbox.monkeyLatestPausedState_(), null);
});

test('最後一行是 PAUSED → 讀得出 RUN_ID、種子、亂數狀態、進度', function () {
  const env = makeEnv({ monkeyState: [monkeyStateRow()] });
  const pending = env.sandbox.monkeyLatestPausedState_();
  assert.ok(pending);
  assert.strictEqual(pending.runId, 'MK20281001000000');
  assert.strictEqual(pending.seed, 987654321);
  assert.strictEqual(pending.rngState, 123456789);
  assert.strictEqual(pending.stepsDone, 7);
  assert.strictEqual(pending.targetSteps, 20);
});

// ⚠️ 這一條就是這一輪的主症狀：撳〔繼續亂行〕開了新的 RUN_ID 與新種子，
//    STEP_NO 由 1 數起，目標步數永遠跑不滿——而且完全沒有提示。
test('沒有 PAUSED 紀錄時 resume → 明確拒絕，不會靜靜開新一輪', function () {
  const env = makeEnv({});
  const summary = env.sandbox.runMonkey_({ resume: true });

  assert.strictEqual(summary.ok, false);
  assert.strictEqual(summary.runId, '', '不可以開新的 RUN_ID');
  assert.strictEqual(summary.seed, 0, '不可以開新種子');
  deepEq(summary.steps, []);
  assert.ok(summary.message.indexOf('沒有未完成的執行') !== -1, summary.message);
  assert.ok(summary.message.indexOf('跑亂行機') !== -1, '要指路去〔跑亂行機〕：' + summary.message);
});

test('上一輪已經走滿目標步數 → resume 明確拒絕', function () {
  const env = makeEnv({
    monkeyState: [monkeyStateRow({ STATUS: 'PAUSED', STEPS_DONE: 20, TARGET_STEPS: 20 })]
  });
  const summary = env.sandbox.runMonkey_({ resume: true });
  assert.strictEqual(summary.ok, false);
  assert.ok(summary.message.indexOf('已經走滿') !== -1, summary.message);
});

// =====================================================================
// 續跑：由真正入口 runMonkey_() 叫下去
// =====================================================================

/**
 * 造一個「動作永遠合法、每一步都改變狀態」的環境，令 runMonkey_() 走得完
 * 指定步數，可以驗續跑本身。動作揀邊一個由亂數決定，所以序列可以對數。
 */
function makeResumableEnv(extra) {
  const env = makeEnv(Object.assign({
    config: { MONKEY_NO_PROGRESS_LIMIT: '99' },
    weekRows: [{ SERVICE_DATE: '2028-10-01', QUARTER_ID: '2028T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }]
  }, extra || {}));

  // 不變量不是這一組要驗的東西（見防打轉閘那兩條的說明）。
  env.sandbox.runAllInvariants_ = function () {
    return { results: [], okCount: 0, failedCount: 0, unknownCount: 0, allOk: true, failed: [] };
  };

  // 八個動作，全部永遠合法、每一步都寫一筆 AuditLog（令狀態指紋每步不同）。
  env.sandbox.monkeyActions_ = function () {
    const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    return ids.map(function (id) {
      return {
        id: id, label: '動作' + id,
        available: function () { return true; },
        unavailableReason: function () { return '（永遠合法）'; },
        run: function (ctx) {
          env.sandbox.appendAuditLog_({
            action: 'MONKEY_TEST', sheetName: 'x', rowKey: String(ctx.stepNo),
            field: 'f', oldValue: '', newValue: id, notes: ''
          });
          return env.sandbox.monkeyStepResult_(true, '走了 ' + id);
        }
      };
    });
  };
  return env;
}

function chosenSequence(summary) {
  return summary.steps.map(function (step) { return step.chosenId; });
}

// ⚠️ 這一條是 prompt 的自我檢驗，而且是由**真正入口** runMonkey_() 叫下去，
//    不是只驗亂數產生器：同一個種子由頭跑滿 12 步，與分三批續跑到 12 步，
//    揀中的動作序列必須完全相同。
//
//    ⚠️ 分批那一邊要真的**經 MonkeyState 續跑**（runMonkey_({resume:true})），
//    不可以只叫三次新一輪——那樣測試會恆真，等於沒有驗。
test('續跑等價（真正入口）：一次過 12 步 vs 分三批續跑，動作序列完全相同', function () {
  const baseline = chosenSequence(makeResumableEnv().sandbox.runMonkey_({ steps: 12, seed: 20281001 }));
  assert.strictEqual(baseline.length, 12, '基準要真的走滿 12 步');

  const env = makeResumableEnv();
  const collected = [];
  let done = 0;

  [4, 4, 4].forEach(function (batchSize, index) {
    if (index === 0) {
      // 第一批：開新一輪，但只走 4 步（目標仍然是 12）。
      const first = env.sandbox.runMonkey_({ steps: batchSize, seed: 20281001 });
      collected.push.apply(collected, chosenSequence(first));
      done = batchSize;
      // 把目標改成 12、狀態改成 PAUSED，模擬「時間到，走了 4 步就停低」。
      env.sandbox.monkeyWriteStateRow_({
        runId: first.runId, seed: 20281001, targetSteps: 12, stepsDone: done,
        rngState: env2RngState(env, 20281001, done), status: 'PAUSED',
        startedAt: new Date(), notes: ''
      });
      return;
    }

    const pending = env.sandbox.monkeyLatestPausedState_();
    assert.ok(pending, '第 ' + (index + 1) + ' 批之前應該有 PAUSED 紀錄');
    const batch = env.sandbox.runMonkey_({ resume: true });
    assert.strictEqual(batch.ok, true, batch.message);
    assert.strictEqual(batch.stepsDoneBefore, done, 'STEP_NO 要接住上一批');

    collected.push.apply(collected, chosenSequence(batch).slice(0, batchSize));
    done += batchSize;

    if (done < 12) {
      env.sandbox.monkeyWriteStateRow_({
        runId: batch.runId, seed: 20281001, targetSteps: 12, stepsDone: done,
        rngState: env2RngState(env, 20281001, done), status: 'PAUSED',
        startedAt: new Date(), notes: ''
      });
    }
  });

  deepEq(collected, baseline, '分三批續跑走的路必須與一次過跑完全相同');
});

// ⚠️ 上面那一條如果測試本身寫錯（例如三批都叫新一輪），會恆真。這一條
//    專門守住「續跑真的接得上」：把 RNG_STATE 寫錯，序列就一定接不上。
test('續跑：RNG_STATE 錯了 → 序列接不上（證明上一條測得到分別）', function () {
  const baseline = chosenSequence(makeResumableEnv().sandbox.runMonkey_({ steps: 8, seed: 424242 }));

  const env = makeResumableEnv({
    monkeyState: [{
      RUN_ID: 'MK_WRONG_STATE', SEED: '424242', TARGET_STEPS: 8, STEPS_DONE: 4,
      // 由頭開始的狀態，而不是抽了 4 次之後的狀態——即是舊版那種「只存種子」。
      RNG_STATE: String(424242), STATUS: 'PAUSED',
      STARTED_AT: '2028-10-01', UPDATED_AT: '2028-10-01', NOTES: ''
    }]
  });
  const resumed = chosenSequence(env.sandbox.runMonkey_({ resume: true }));

  assert.notStrictEqual(JSON.stringify(resumed), JSON.stringify(baseline.slice(4)),
    '只存種子而不存亂數狀態，續跑會由頭重播——這一條要抓得到那個分別');
});

test('續跑：沿用同一個 RUN_ID 與種子，STEP_NO 接上去', function () {
  const env = makeResumableEnv();
  const first = env.sandbox.runMonkey_({ steps: 6, seed: 555 });

  // 人手把狀態改成「只走了 2 步」，模擬中途停低。
  const stateRows = env.sandbox.readSheet(env.sandbox.SHEETS.MONKEY_STATE);
  assert.ok(stateRows.length >= 1, '跑完要寫一行 MonkeyState');

  const env2 = makeResumableEnv({
    monkeyState: [{
      RUN_ID: 'MK_RESUME_TEST', SEED: '555', TARGET_STEPS: 6, STEPS_DONE: 2,
      RNG_STATE: String(env2RngState(env, 555, 2)), STATUS: 'PAUSED',
      STARTED_AT: '2028-10-01', UPDATED_AT: '2028-10-01', NOTES: ''
    }]
  });
  const resumed = env2.sandbox.runMonkey_({ resume: true });

  assert.strictEqual(resumed.runId, 'MK_RESUME_TEST', '要沿用同一個執行編號');
  assert.strictEqual(resumed.seed, 555, '要沿用同一個種子');
  assert.strictEqual(resumed.stepsDoneBefore, 2);
  assert.strictEqual(resumed.steps[0].stepNo, 3, 'STEP_NO 要由 3 接上去，不是由 1 數起');
  assert.strictEqual(resumed.totalStepsDone, 6);
  assert.strictEqual(resumed.status, 'DONE');
  assert.strictEqual(resumed.resumed, true);

  // 續跑那一段的動作序列，要與一次過跑的第 3 至 6 步相同。
  deepEq(chosenSequence(resumed), chosenSequence(first).slice(2));
});

/** 算出「用某個種子抽了 n 次之後」的亂數內部狀態。 */
function env2RngState(env, seed, draws) {
  const r = env.sandbox.monkeyRandom_(seed);
  for (let i = 0; i < draws; i++) r.nextInt(8);
  return r.state();
}

test('跑滿目標步數 → MonkeyState 記 DONE，之後撳續跑會被拒絕', function () {
  const env = makeResumableEnv();
  const summary = env.sandbox.runMonkey_({ steps: 5, seed: 321 });
  assert.strictEqual(summary.status, 'DONE');

  const rows = env.sandbox.readSheet(env.sandbox.SHEETS.MONKEY_STATE);
  assert.strictEqual(String(rows[rows.length - 1].STATUS), 'DONE');

  const again = env.sandbox.runMonkey_({ resume: true });
  assert.strictEqual(again.ok, false);
  assert.ok(again.message.indexOf('沒有未完成的執行') !== -1, again.message);
});

test('MonkeyState：每一批新增一行，不刪行', function () {
  const env = makeResumableEnv();
  env.sandbox.runMonkey_({ steps: 3, seed: 111 });
  const after1 = env.sandbox.readSheet(env.sandbox.SHEETS.MONKEY_STATE).length;
  env.sandbox.runMonkey_({ steps: 3, seed: 222 });
  const after2 = env.sandbox.readSheet(env.sandbox.SHEETS.MONKEY_STATE).length;
  assert.strictEqual(after2, after1 + 1, '每一批新增一行');
});

// ⚠️ 種子與亂數狀態是 32 位元整數，當成數字存會被試算表改寫成科學記數法，
//    續跑就還原不到正確的狀態。
test('MonkeyState：SEED 與 RNG_STATE 登記為純文字欄', function () {
  const env = makeEnv({});
  const def = env.sandbox.COLUMNS.MONKEY_STATE;
  assert.ok(def.textFormatColumns.indexOf('SEED') !== -1);
  assert.ok(def.textFormatColumns.indexOf('RNG_STATE') !== -1);
});

// =====================================================================
// 走過的路：累計、跨批接得上
// =====================================================================

// ⚠️ 「走到這裏的完整步驟」是亂行機**最重要的輸出**——一條隨機路徑紅了，
//    重現不到那個發現就等於零。舊版 pathSoFar 是一個 local 陣列，每一批
//    由空開始，所以續跑之後路徑由第 1 步重新數。
//    見 docs/已知bug類型.md 事故三十八。
test('走過的路：跑 20 步，第 20 步的路徑包含 20 個動作', function () {
  const env = makeResumableEnv();
  const summary = env.sandbox.runMonkey_({ steps: 20, seed: 4242 });

  assert.strictEqual(summary.steps.length, 20, summary.message);
  const last = summary.steps[summary.steps.length - 1];
  assert.strictEqual(last.pathSoFar.split(' → ').length, 20,
    '第 20 步的路徑應該有 20 個動作：' + last.pathSoFar);
  assert.strictEqual(summary.pathSteps.length, 20);
  assert.strictEqual(summary.pathSteps[0].stepNo, 1, '一定要由第 1 步開始');
  assert.strictEqual(summary.pathSteps[19].stepNo, 20);
});

test('走過的路：跨批續跑接得上，最後一步的路徑仍然由第 1 步數起', function () {
  const env = makeResumableEnv();

  const first = env.sandbox.runMonkey_({ steps: 4, seed: 4242 });
  assert.strictEqual(first.steps.length, 4);

  // 模擬「時間到，走了 4 步就停低」：目標改成 10、狀態改成 PAUSED，
  // 而且**帶住已經走過的路**。
  env.sandbox.monkeyWriteStateRow_({
    runId: first.runId, seed: 4242, targetSteps: 10, stepsDone: 4,
    rngState: env2RngState(env, 4242, 4), status: 'PAUSED',
    startedAt: new Date(), pathSteps: first.pathSteps, notes: ''
  });

  const second = env.sandbox.runMonkey_({ resume: true });
  assert.strictEqual(second.ok, true, second.message);
  assert.strictEqual(second.stepsDoneBefore, 4);

  const last = second.steps[second.steps.length - 1];
  assert.strictEqual(last.pathSoFar.split(' → ').length, 10,
    '續跑之後路徑要接住上一批，不可以由第 1 步重新數：' + last.pathSoFar);
  assert.strictEqual(second.pathSteps[0].stepNo, 1, '第 1 步要仍然在');
  assert.strictEqual(second.pathSteps[9].stepNo, 10);
});

test('走過的路：寫入 MonkeyState 的是精簡格式，讀回來解得出', function () {
  const env = makeResumableEnv();
  const summary = env.sandbox.runMonkey_({ steps: 3, seed: 77 });

  const rows = env.sandbox.readSheet(env.sandbox.SHEETS.MONKEY_STATE);
  const stored = String(rows[rows.length - 1].PATH_SO_FAR || '');
  assert.ok(stored.indexOf('1:') === 0, '精簡格式要由 1: 開始：' + stored);

  const decoded = env.sandbox.decodeMonkeyPath_(stored);
  deepEq(decoded, summary.pathSteps);
});
// =====================================================================
// 摘要：累計進度
// =====================================================================

test('摘要顯示累計步數，不是本批步數', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildMonkeyShortSummary_(fakeSummary({
    stepsDoneBefore: 9, totalStepsDone: 14, targetSteps: 20,
    steps: [{ stepNo: 10, availableIds: ['EDIT_FIELDS'], chosenId: 'EDIT_FIELDS',
      chosenLabel: '改幾格', result: 'OK', detail: 'x', invariantStatus: 'ok',
      invariantFailures: [], pathSoFar: 'x' }]
  }));
  assert.ok(text.indexOf('走了 14／20 步') !== -1, text);
  assert.ok(text.indexOf('（本批 1 步）') !== -1, '要同時講本批走了幾多步：' + text);
});

test('摘要顯示 RUN_ID 與種子', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildMonkeyShortSummary_(fakeSummary());
  assert.ok(text.indexOf('MK20281001000000') !== -1, text);
  assert.ok(text.indexOf('987654321') !== -1, text);
});

test('跑滿目標步數 → 摘要寫「已完成 20／20 步」', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildMonkeyShortSummary_(fakeSummary({
    totalStepsDone: 20, targetSteps: 20, status: 'DONE'
  }));
  assert.ok(text.indexOf('已完成 20／20 步') !== -1, text);
});

// =====================================================================
// 覆蓋統計
// =====================================================================

test('覆蓋統計：列出每個動作被揀中幾多次', function () {
  const env = makeEnv({});
  const line = env.sandbox.monkeyCoverageHeadline_(fakeSummary().coverage);
  assert.ok(line.indexOf('CREATE_WEEKS 1') !== -1, line);
  assert.ok(line.indexOf('IMPORT_CONTENT 1') !== -1, line);
});

// ⚠️ 零次被揀中一定要**明確標出**。不標的話，一個從來沒有跑過的動作
//    看起來與「跑過而且沒事」一模一樣。
test('覆蓋統計：零次而且有資格的，標成「從未揀中」', function () {
  const env = makeEnv({});
  const lines = env.sandbox.monkeyCoverageProblemLines_(fakeSummary().coverage).join('\n');
  assert.ok(lines.indexOf('從未揀中') !== -1, lines);
  assert.ok(lines.indexOf('EDIT_FIELDS') !== -1, lines);
});

// ⚠️ 「從未揀中」與「不適用」是兩件事：前者有資格但抽不中（可能是亂數有
//    問題），後者根本沒有資格。分開講，而且不適用的要寫原因。
test('覆蓋統計：零次而且不適用的，另外標並寫明原因', function () {
  const env = makeEnv({});
  const lines = env.sandbox.monkeyCoverageProblemLines_(fakeSummary().coverage).join('\n');
  assert.ok(lines.indexOf('不適用（未進入候選）：PUBLISH') !== -1, lines);
  assert.ok(lines.indexOf('SELFTEST_MASTER_PDF_FILE_ID') !== -1, '要寫明原因：' + lines);
  // PUBLISH 不可以同時出現在「從未揀中」那一行。
  const neverLine = lines.split('\n').filter(function (l) { return l.indexOf('從未揀中') !== -1; })[0] || '';
  assert.ok(neverLine.indexOf('PUBLISH') === -1, 'PUBLISH 是不適用，不是抽不中：' + neverLine);
});

test('覆蓋統計：全部動作都揀過 → 明講「每一個動作都至少被揀中過一次」', function () {
  const env = makeEnv({});
  const lines = env.sandbox.monkeyCoverageProblemLines_([
    { id: 'A', label: 'a', chosen: 3, notApplicableReasons: [] },
    { id: 'B', label: 'b', chosen: 1, notApplicableReasons: [] }
  ]).join('\n');
  assert.ok(lines.indexOf('每一個動作都至少被揀中過一次') !== -1, lines);
});

test('報告與摘要都有覆蓋統計那一段', function () {
  const env = makeEnv({});
  const report = env.sandbox.buildMonkeyReportLines_(fakeSummary()).join('\n');
  const short = env.sandbox.buildMonkeyShortSummary_(fakeSummary());
  assert.ok(report.indexOf('動作覆蓋：') !== -1, report);
  assert.ok(short.indexOf('動作覆蓋：') !== -1, short);
});

// =====================================================================
// 候選清單與不適用原因
// =====================================================================

// ⚠️ prompt 第 2 部分假設 A 提過：要查清楚「可選動作」欄是不是照抄全部
//    動作清單。查完的結論是——它記錄的**確實是實際候選**（filter 之後),
//    不是全部動作。這一條把那個結論固定落來。
test('可選動作記錄的是**實際候選**，不是全部動作清單', function () {
  const env = makeEnv({});
  const actions = env.sandbox.monkeyActions_();
  const split = env.sandbox.monkeySplitActions_(actions, {
    weekCount: 0, announcementCount: 0, hasContentFolder: false,
    hasContentSheet: false, hasSandboxMaster: false, canRenderDocx: false,
    hasRecipients: false
  });
  assert.ok(split.available.length < actions.length,
    '這個狀態之下只有 CREATE_WEEKS 合法，候選不可以等於全部動作');
  deepEq(split.available.map(function (a) { return a.id; }), ['CREATE_WEEKS']);
  assert.strictEqual(split.unavailable.length, actions.length - 1);
});

test('每一個動作都有 unavailableReason（不可以靜靜由候選剔走）', function () {
  const env = makeEnv({});
  const bad = [];
  env.sandbox.monkeyActions_().forEach(function (action) {
    const actionId = action.id;
    if (typeof action.unavailableReason !== 'function') bad.push(actionId);
  });
  assert.strictEqual(bad.length, 0, '這幾個動作講不出為甚麼不合法：' + bad.join('、'));
});

test('每一個不合法的動作都講得出原因，而且不是空字串', function () {
  const env = makeEnv({});
  const split = env.sandbox.monkeySplitActions_(env.sandbox.monkeyActions_(), {
    weekCount: 0, announcementCount: 0, hasContentFolder: false,
    hasContentSheet: false, hasSandboxMaster: false, canRenderDocx: false,
    hasRecipients: false
  });
  split.unavailable.forEach(function (item) {
    const actionId = item.id;
    assert.ok(item.reason && item.reason.length > 0, actionId + ' 沒有原因');
    assert.ok(item.reason.indexOf('沒有講明原因') === -1, actionId + ' 的原因是佔位字串');
  });
});

// ⚠️ PUBLISH 是整個系統副作用最大的動作，它零次被揀中一定要有人見到理由。
test('沙盒 master 未設定 → PUBLISH 的原因講明是哪一個設定鍵，並講明不會碰正式那一個', function () {
  const env = makeEnv({});
  const publish = env.sandbox.monkeyActions_().filter(function (a) { return a.id === 'PUBLISH'; })[0];
  const reason = publish.unavailableReason({ weekCount: 5, hasSandboxMaster: false });
  assert.ok(reason.indexOf('SELFTEST_MASTER_PDF_FILE_ID') !== -1, reason);
  assert.ok(reason.indexOf('PUBLISHED_PDF_FILE_ID') !== -1, '要講明不會碰正式那一個：' + reason);
});

// ⚠️ 亂行機的 PUBLISH 一律經 selfTestRunPublish_（它會把發佈指去沙盒
//    master，跑完還原），絕對不可以直接用 runPublishFlow_。
test('PUBLISH 一定經 selfTestRunPublish_，不會直接叫 runPublishFlow_', function () {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'MonkeyRun.gs'), 'utf8');
  assert.ok(src.indexOf('selfTestRunPublish_') !== -1, '要經沙盒發佈包裝');
  assert.ok(src.indexOf('runPublishFlow_(') === -1,
    '亂行機不可以直接叫 runPublishFlow_——那會覆寫正式 master 檔案');
  assert.ok(src.indexOf('PUBLISHED_PDF_FILE_ID') !== -1
    && src.indexOf('setConfig') === -1,
    '亂行機自己不可以改 Config（改指沙盒那一步在 selfTestRunPublish_ 裡面做）');
});

// ⚠️ 每次 PUBLISH 要用內容不同的 PDF，否則第二次之後全部被
//    UPLOAD_IS_CURRENT_MASTER 擋住，看起來像「跑過了」其實沒有驗到發佈。
test('PUBLISH 每次用內容不同的 PDF（帶 RUN_ID 與步數，而且是 ASCII）', function () {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'MonkeyRun.gs'), 'utf8');
  const body = src.slice(src.indexOf("id: 'PUBLISH'"), src.indexOf("id: 'SEND_DRY_RUN'"));
  assert.ok(body.indexOf('ctx.runId') !== -1 && body.indexOf('ctx.stepNo') !== -1,
    'PDF 內容要帶 RUN_ID 與步數：' + body);
  // selfTestMakePdfBlob_ 會把非 ASCII 換成 ?，所以文字一定要是 ASCII。
  const call = body.slice(body.indexOf("selfTestMakePdfBlob_('"));
  const text = call.slice(call.indexOf("('") + 2, call.indexOf("'", call.indexOf("('") + 2));
  assert.ok(/^[ -~]*$/.test(text), 'PDF 內文要用 ASCII，否則兩份會變成同一份：' + text);
});

// =====================================================================
// 防打轉閘
// =====================================================================

// ⚠️ 這個閘從來沒有響過，即是從來沒有驗證過它是否真的會響。
test('防打轉閘：連續 N 步狀態完全沒有變 → 停手並報「偵測到原地打轉」', function () {
  const env = makeEnv({
    config: { MONKEY_NO_PROGRESS_LIMIT: '3' },
    weekRows: [{ SERVICE_DATE: '2028-10-01', QUARTER_ID: '2028T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }]
  });


  // ⚠️ 這一組測試驗的是**閘**，不是不變量。這個骨架環境沒有職事表，
  //    I03 一定紅，於是第一步就會停手，閘永遠沒有機會響——那樣就變成
  //    「測試造不出應該綠的情況」。所以這裡把不變量檢查換成永遠通過。
  env.sandbox.runAllInvariants_ = function () {
    return { results: [], okCount: 0, failedCount: 0, unknownCount: 0, allOk: true, failed: [] };
  };

  // 人為造一個「每一步都不改變狀態」的動作：唯讀、永遠合法。
  env.sandbox.monkeyActions_ = function () {
    return [{
      id: 'NOOP', label: '甚麼都不做',
      available: function () { return true; },
      unavailableReason: function () { return '（永遠合法）'; },
      run: function () { return env.sandbox.monkeyStepResult_(true, '甚麼都沒有改'); }
    }];
  };

  const summary = env.sandbox.runMonkey_({ steps: 20 });
  assert.strictEqual(summary.ok, true, summary.message);
  assert.strictEqual(summary.stoppedForNoProgress, true,
    '走了 ' + summary.steps.length + ' 步都沒有響閘');
  assert.ok(summary.steps.length <= 5, '應該在頭幾步就停手，實際走了 ' + summary.steps.length + ' 步');

  const report = env.sandbox.buildMonkeyReportLines_(summary).join('\n');
  assert.ok(report.indexOf('偵測到原地打轉') !== -1, report);
});

test('防打轉閘：狀態每一步都有變 → 不會響', function () {
  const env = makeEnv({
    config: { MONKEY_NO_PROGRESS_LIMIT: '3' },
    weekRows: [{ SERVICE_DATE: '2028-10-01', QUARTER_ID: '2028T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }]
  });


  // ⚠️ 這一組測試驗的是**閘**，不是不變量。這個骨架環境沒有職事表，
  //    I03 一定紅，於是第一步就會停手，閘永遠沒有機會響——那樣就變成
  //    「測試造不出應該綠的情況」。所以這裡把不變量檢查換成永遠通過。
  env.sandbox.runAllInvariants_ = function () {
    return { results: [], okCount: 0, failedCount: 0, unknownCount: 0, allOk: true, failed: [] };
  };

  // 每一步都寫一筆 AuditLog，於是狀態指紋每一步都不同。
  env.sandbox.monkeyActions_ = function () {
    return [{
      id: 'TOUCH', label: '寫一筆紀錄',
      available: function () { return true; },
      unavailableReason: function () { return '（永遠合法）'; },
      run: function (ctx) {
        env.sandbox.appendAuditLog_({
          action: 'MONKEY_TEST', sheetName: 'x', rowKey: String(ctx.stepNo),
          field: 'f', oldValue: '', newValue: String(ctx.stepNo), notes: ''
        });
        return env.sandbox.monkeyStepResult_(true, '寫咗一筆');
      }
    }];
  };

  const summary = env.sandbox.runMonkey_({ steps: 6 });
  assert.strictEqual(summary.stoppedForNoProgress, false,
    '狀態每一步都有變，不應該報原地打轉');
  assert.strictEqual(summary.steps.length, 6);
});

// ⚠️ 動作拋錯要記入紀錄並繼續，不可以靜靜重揀一個——靜靜重揀的話那個
//    動作會永遠零次被揀中，而錯誤完全消失。
test('動作拋錯 → 記入紀錄並繼續，覆蓋統計照樣算它被揀中過', function () {
  const env = makeEnv({
    config: { MONKEY_NO_PROGRESS_LIMIT: '99' },
    weekRows: [{ SERVICE_DATE: '2028-10-01', QUARTER_ID: '2028T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' }]
  });


  // ⚠️ 這一組測試驗的是**閘**，不是不變量。這個骨架環境沒有職事表，
  //    I03 一定紅，於是第一步就會停手，閘永遠沒有機會響——那樣就變成
  //    「測試造不出應該綠的情況」。所以這裡把不變量檢查換成永遠通過。
  env.sandbox.runAllInvariants_ = function () {
    return { results: [], okCount: 0, failedCount: 0, unknownCount: 0, allOk: true, failed: [] };
  };

  env.sandbox.monkeyActions_ = function () {
    return [{
      id: 'ALWAYS_THROWS', label: '一定拋錯',
      available: function () { return true; },
      unavailableReason: function () { return '（永遠合法）'; },
      run: function () { throw new Error('故意拋的錯'); }
    }];
  };

  const summary = env.sandbox.runMonkey_({ steps: 3 });
  assert.ok(summary.steps.length >= 1, '拋錯之後要繼續走');
  assert.strictEqual(summary.steps[0].result, 'FAILED');
  assert.strictEqual(summary.steps[0].chosenId, 'ALWAYS_THROWS');
  assert.ok(summary.steps[0].detail.indexOf('故意拋的錯') !== -1, summary.steps[0].detail);

  const publish = summary.coverage.filter(function (c) { return c.id === 'ALWAYS_THROWS'; })[0];
  assert.ok(publish.chosen >= 1, '拋錯照樣算被揀中過，不可以扮無揀過');

  const logged = env.sandbox.readSheet(env.sandbox.SHEETS.MONKEY_LOG);
  assert.ok(logged.length >= 1, '拋錯那一步要寫入 MonkeyLog');
  assert.ok(String(logged[0].RESULT).indexOf('故意拋的錯') !== -1, String(logged[0].RESULT));
});

test('報告：亂數種子印在開頭（沒有它就重現不到）', function () {
  const env = makeEnv({});
  const lines = env.sandbox.buildMonkeyReportLines_(fakeSummary());

  assert.ok(lines.slice(0, 3).join('\n').indexOf('987654321') !== -1,
    '種子必須印在報告開頭：' + lines.slice(0, 3).join(' | '));
  // ⚠️ 措辭改了：由「同一個種子重跑」改成「用同一個種子**由乾淨狀態**重跑」。
  //    舊措辭會令人以為〔繼續亂行〕＝重播那一條路，而沙盒的狀態已經被上
  //    一批改過，重播不到。見 docs/已知bug類型.md 事故三十四。
  assert.ok(lines.slice(0, 3).join('\n').indexOf('由乾淨狀態重跑') !== -1,
    '要講明種子的用途，而且要講明前提是乾淨狀態');
});

test('報告：紅了的話，「走到這裏的完整步驟」一定要印出來', function () {
  const env = makeEnv({});
  const summary = fakeSummary();
  summary.failedStep = summary.steps[1];

  const text = env.sandbox.buildMonkeyReportLines_(summary).join('\n');
  assert.ok(text.indexOf('走到這裏的完整步驟') !== -1, text);
  assert.ok(text.indexOf('建立本季空白週報 → 從內容表匯入') !== -1,
    '沒有完整步驟，紅了也重現不到：' + text);
  assert.ok(text.indexOf('I08') !== -1 && text.indexOf('4 項改動') !== -1,
    '要連不變量的預期與實際一齊印：' + text);
});

test('報告：逐步記錄印出「合法動作」與「揀了甚麼」', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildMonkeyReportLines_(fakeSummary()).join('\n');

  assert.ok(text.indexOf('第 1 步') !== -1, text);
  assert.ok(text.indexOf('CREATE_WEEKS') !== -1, text);
  assert.ok(text.indexOf('揀了：建立本季空白週報') !== -1, text);
  assert.ok(text.indexOf('不變量：') !== -1, text);
});

test('報告：停低了要講明，而且指路去〔繼續亂行〕', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildMonkeyReportLines_(fakeSummary({ stoppedForTime: true })).join('\n');
  assert.ok(text.indexOf('執行時間到') !== -1, text);
  assert.ok(text.indexOf('繼續亂行') !== -1, text);
});

test('報告：全部走完而且沒有紅 → 明確講「每一步之後不變量都成立」', function () {
  const env = makeEnv({});
  const text = env.sandbox.buildMonkeyReportLines_(fakeSummary({ requestedSteps: 2 })).join('\n');
  assert.ok(text.indexOf('每一步之後不變量都成立') !== -1, text);
});

test('報告：守門擋住時只講守門訊息，不假裝走過', function () {
  const env = makeEnv({});
  const lines = env.sandbox.buildMonkeyReportLines_({ ok: false, message: '守門訊息' });
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].indexOf('守門訊息') !== -1);
});

test('對話框摘要：紅了要連完整步驟一齊講', function () {
  const env = makeEnv({});
  const summary = fakeSummary();
  summary.failedStep = summary.steps[1];

  const text = env.sandbox.buildMonkeyShortSummary_(summary);
  assert.ok(text.indexOf('走到這裏的完整步驟') !== -1, text);
  assert.ok(text.indexOf('建立本季空白週報 → 從內容表匯入') !== -1, text);
  assert.ok(text.indexOf('MonkeyLog') !== -1, '要指路去完整記錄：' + text);
});

test('報告與摘要的文字是書面語繁體中文', function () {
  const env = makeEnv({});
  const summary = fakeSummary();
  summary.failedStep = summary.steps[1];

  assertWrittenChinese(assert, '亂行報告', env.sandbox.buildMonkeyReportLines_(summary).join('\n'));
  assertWrittenChinese(assert, '亂行摘要', env.sandbox.buildMonkeyShortSummary_(summary));
  assertWrittenChinese(assert, '亂行報告（停低）',
    env.sandbox.buildMonkeyReportLines_(fakeSummary({ stoppedForTime: true })).join('\n'));
});

// =====================================================================
// 狀態判斷
// =====================================================================

test('monkeyCurrentState_：只數沙盒季度那幾行，不會把真實季度算進去', function () {
  const env = makeEnv({
    weekRows: [
      { SERVICE_DATE: '2028-10-01', QUARTER_ID: '2028T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' },
      { SERVICE_DATE: '2027-11-07', QUARTER_ID: '2027T4', WEEK_OF_MONTH: 1, STATUS: 'DRAFT' },
      { SERVICE_DATE: '2028-10-08', QUARTER_ID: '2028T4', WEEK_OF_MONTH: 2, STATUS: 'DRAFT' }
    ]
  });
  const state = env.sandbox.monkeyCurrentState_(env.sandbox.selfTestConfig_());
  assert.strictEqual(state.weekCount, 2, '只應該數 2028T4 那兩行');
});

test('monkeyCurrentState_：沒有設定沙盒 master／內容表資料夾時，對應旗標是 false', function () {
  const env = makeEnv({});
  const state = env.sandbox.monkeyCurrentState_(env.sandbox.selfTestConfig_());
  assert.strictEqual(state.hasSandboxMaster, false);
  assert.strictEqual(state.hasContentFolder, false);
});

test('monkeyLatestSeed_：沒有記錄回空字串，有記錄回最後一個種子', function () {
  const empty = makeEnv({});
  assert.strictEqual(empty.sandbox.monkeyLatestSeed_(), '');

  const withLog = makeEnv({
    monkeyLog: [
      { RUN_ID: 'MK1', SEED: '111', STEP_NO: 1, AVAILABLE_ACTIONS: 'a', CHOSEN_ACTION: 'a', RESULT: 'OK', INVARIANT_STATUS: 'ok', PATH_SO_FAR: 'a', TIMESTAMP: '2028-10-01' },
      { RUN_ID: 'MK2', SEED: '222', STEP_NO: 1, AVAILABLE_ACTIONS: 'a', CHOSEN_ACTION: 'a', RESULT: 'OK', INVARIANT_STATUS: 'ok', PATH_SO_FAR: 'a', TIMESTAMP: '2028-10-02' }
    ]
  });
  assert.strictEqual(withLog.sandbox.monkeyLatestSeed_(), '222');
});

// =====================================================================

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
