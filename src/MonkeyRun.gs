/**
 * MonkeyRun.gs
 *
 * 第 3 層：**亂行機**——由沙盒季度當前的狀態出發，列出**現在合法的動作**，
 * 隨機揀一個執行，然後跑一次全部不變量。重覆 N 次。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 它抓的是甚麼
 * ─────────────────────────────────────────────────────────────────────
 *
 *   第 2 層的自測機跑的是**人想得到的次序**：建立 → 匯入 → 產生 → 發佈。
 *   但真實的幹事不會照劇本走——他們會在匯入到一半去改格、產生完 Word 之後
 *   再匯入、發佈完再改內容再發佈。
 *
 *   亂行機抓的正是「**沒有人想過要這樣撳**」那一類狀態。它不需要知道
 *   哪一條路是對的，它只需要：走一步、檢查一次全部不變量、記低走過的路。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 最重要的輸出：走到這裏的完整步驟
 * ─────────────────────────────────────────────────────────────────────
 *
 *   一條隨機路徑紅了，如果重現不到，那個發現等於零。所以每一步都記
 *   `PATH_SO_FAR`（走到這裏的完整步驟），而且亂數種子固定、寫在報告開頭
 *   ——**同一個種子重跑走同一條路**。
 *
 *   ⚠️ Apps Script 沒有可以設種子的亂數產生器，`Math.random()` 也不可以
 *   設種子。所以這裡自己實作一個極簡的線性同餘產生器
 *   （`monkeyRandom_()`）——它不需要有多好的統計性質，只需要**可重覆**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 絕對不准
 * ─────────────────────────────────────────────────────────────────────
 *
 *   安裝觸發器、真實寄信、碰非沙盒季度、改 Config、寫職事表、
 *   覆寫正式的 master 發佈檔案。
 *
 *   前五樣靠「動作清單裡面根本沒有那些動作」＋ 沙盒守門保證；
 *   最後一樣靠 `SELFTEST_MASTER_PDF_FILE_ID`（沒有設定就不會有發佈動作）。
 */

'use strict';

/** 亂行機每一步的結果。 */
var MONKEY_STEP_RESULT_ = Object.freeze({ OK: 'OK', FAILED: 'FAILED', SKIPPED: 'SKIPPED' });

/** 每跑幾多步重新斷言一次 `DRY_RUN`。 */
var MONKEY_DRY_RUN_RECHECK_EVERY_ = 10;

/**
 * 用途：一個可以設種子、**可重覆、而且可以續跑**的亂數產生器
 *   （mulberry32）。
 *
 *   ⚠️ 刻意不用 `Math.random()`：它設不到種子、也拿不到內部狀態，所以
 *   同一次紅燈永遠重現不到，而且〔繼續亂行〕一定接不上。
 *
 *   ⚠️ **為什麼由線性同餘（LCG）換成 mulberry32**——這是實測出來的缺陷，
 *   不是口味問題（見 docs/已知bug類型.md 事故三十五）：
 *
 *   舊版是 `state = (1664525 * state + 1013904223) % 2^32`，然後
 *   `state % bound` 取值。模 2 的冪的 LCG，**低位元的週期極短**：低 k 個
 *   位元的週期只有 2^k。而 `% bound` 取的正正是低位元。實測：
 *
 *   ```
 *   nextInt(2) → 1,0,1,0,1,0,1,0…      完全交替
 *   nextInt(4) → 1,0,3,2,1,0,3,2…      週期 4
 *   nextInt(8) → 1,4,3,6,5,0,7,2,1,4…  週期 8，永遠這個循環
 *   ```
 *
 *   八個候選動作的時候，「隨機揀一個」其實是一個**固定的八循環**。更差的
 *   是：種子取自時間戳記，連續幾次執行的種子很接近，於是三次「不同」的
 *   執行只是同一個循環的旋轉。
 *
 *   ⚠️ 數 100000 次的分佈會顯示完美平均（每個各 12500 次），所以**用分佈
 *   去驗是驗不出來的**——要驗的是「序列」，不是「次數」。
 *
 *   兩處修正：
 *     1. 換成 mulberry32（有雪崩效應，低位元不再有短週期）；
 *     2. `nextInt()` 用**高位元**（`v / 2^32 * bound`），不用 `v % bound`。
 *
 * Args:
 *   seed {number} 種子。
 *   savedState {number=} 續跑時還原的內部狀態；不提供就由種子開始。
 * Returns:
 *   {{nextInt:function(number): number, seed:number, state:function(): number}}
 *     `nextInt(n)` 回 `0` 至 `n-1`；`state()` 回目前內部狀態，存低就續得到。
 */
function monkeyRandom_(seed, savedState) {
  var hasSaved = savedState !== undefined && savedState !== null && savedState !== '';
  var state = hasSaved ? (Number(savedState) >>> 0) : (Number(seed) >>> 0);

  function nextUint32() {
    state = (state + 0x6D2B79F5) >>> 0;
    var t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  }

  return {
    seed: Number(seed) >>> 0,
    nextInt: function (n) {
      var bound = Math.max(1, Math.floor(n));
      // ⚠️ 用高位元。`nextUint32() % bound` 會走回舊版那個坑。
      var value = Math.floor((nextUint32() / 4294967296) * bound);
      return value >= bound ? bound - 1 : value;
    },
    state: function () { return state; }
  };
}

// =====================================================================
// 動作
// =====================================================================

/**
 * 用途：列出「以沙盒季度目前的狀態，現在合法的動作」。
 *
 *   ⚠️ 每一個動作都要有 `available(state)`——**不合法的動作根本不會被
 *   揀到**。這比「揀到之後才發現做不到」乾淨：報告裡的「可選動作」那一欄
 *   才會誠實反映當時的狀態。
 *
 *   ⚠️ 清單裡**沒有**安裝觸發器、真實寄信、改 Config、寫職事表——不是
 *   靠執行時擋，是靠「根本沒有這個選項」。
 * Args: （無）
 * Returns:
 *   {{id:string, label:string, available:function(Object): boolean,
 *     run:function(Object): Object}[]}
 */
function monkeyActions_() {
  return [
    {
      id: 'CREATE_WEEKS',
      label: '建立本季空白週報',
      available: function (state) { return state.weekCount === 0; },
      unavailableReason: function (state) {
        return '沙盒季度已經有 ' + state.weekCount + ' 行週報，不需要再建立骨架';
      },
      run: function (ctx) {
        var outcome = selfTestS01_(ctx);
        return monkeyStepResult_(outcome.ok !== false, '建立了骨架：' + outcome.actual);
      }
    },
    {
      id: 'EDIT_FIELDS',
      label: '經填寫介面改幾格',
      available: function (state) { return state.weekCount > 0; },
      unavailableReason: function () { return '沙盒季度未有任何週報（要先建立骨架）'; },
      run: function (ctx) {
        var dates = selfTestSandboxDates_(ctx.config);
        var isoDate = dates[ctx.random.nextInt(dates.length)];
        assertSelfTestWritableDate_(isoDate, ctx.config);

        var loaded = loadWeekForWebApp_(isoDate);
        var fields = ['SERMON_TITLE', 'SCRIPTURE_REF', 'RESPONSE_HYMN', 'HYMN_PRAISE', 'FLOWER_THIS_WEEK'];
        var week = {};
        var howMany = 1 + ctx.random.nextInt(fields.length);
        for (var i = 0; i < howMany; i++) {
          week[fields[i]] = '亂行 ' + ctx.runId + '-' + ctx.stepNo + '-' + i;
        }

        var saved = saveWeekFromWebApp_({
          isoDate: isoDate, lastSavedAt: loaded.lastSavedAt, week: week, dutyEdits: []
        });
        return monkeyStepResult_(true, '主日 ' + isoDate + ' 改了 ' + saved.changedFieldCount + ' 格');
      }
    },
    {
      id: 'CREATE_CONTENT_SHEET',
      label: '建立或刷新內容表',
      available: function (state) { return state.hasContentFolder; },
      unavailableReason: function () {
        return 'Config 的 ' + CONFIG_KEYS.CONTENT_SHEET_FOLDER_ID + ' 是空的，建立不到內容表';
      },
      run: function (ctx) {
        var result = buildOrRefreshContentSheet_(ctx.config.quarterId, {
          fileNameSuffix: SELF_TEST_CONTENT_SUFFIX_,
          serviceDates: selfTestSandboxDates_(ctx.config)
        });
        if (!result.ok) return monkeyStepResult_(false, '失敗：' + (result.message || result.reason));
        return monkeyStepResult_(true, result.created ? '建立了' : '已更新，未重建');
      }
    },
    {
      id: 'WRITE_CONTENT',
      label: '在內容表寫幾條家事報告',
      available: function (state) { return state.hasContentSheet; },
      unavailableReason: function (state) { return state.contentSheetReason || '沙盒季度未有內容表'; },
      run: function (ctx) {
        var row = findContentSheetRow_(ctx.config.quarterId);
        var spreadsheet = openContentSpreadsheet_(row.FILE_ID);
        var tabDef = selfTestFindTabDef_('家事報告');
        var sheet = spreadsheet.getSheetByName(tabDef.tabName);
        var dates = selfTestSandboxDates_(ctx.config);

        selfTestClearContentTab_(sheet, tabDef);
        var howMany = 1 + ctx.random.nextInt(3);
        var rows = [];
        for (var i = 0; i < howMany; i++) {
          rows.push({
            SERVICE_DATE: dates[ctx.random.nextInt(Math.min(dates.length, 4))],
            SEQ_NO: (i + 1) * 10,
            TEXT: '亂行家事 ' + ctx.runId + '-' + ctx.stepNo + '-' + i,
            ACTIVE: 'TRUE'
          });
        }
        writeContentRows_(sheet, tabDef.keys, rows, CONTENT_SHEET_FIRST_DATA_ROW_);
        return monkeyStepResult_(true, '寫了 ' + howMany + ' 條');
      }
    },
    {
      id: 'IMPORT_CONTENT',
      label: '從內容表匯入',
      available: function (state) { return state.hasContentSheet; },
      unavailableReason: function (state) { return state.contentSheetReason || '沙盒季度未有內容表'; },
      run: function (ctx) {
        assertSelfTestWritableQuarter_(ctx.config.quarterId, ctx.config);
        var result = applyContentImport_(ctx.config.quarterId);
        if (!result.ok) return monkeyStepResult_(false, '失敗：' + (result.message || result.reason));
        var plan = result.plan;
        return monkeyStepResult_(true, '新增 ' + plan.added + '、修改 ' + plan.updated
          + '、刪除 ' + plan.removed + '、不變 ' + plan.unchanged);
      }
    },
    {
      id: 'GENERATE_DOCX',
      label: '產生 Word',
      available: function (state) { return state.weekCount > 0 && state.canRenderDocx; },
      unavailableReason: function (state) {
        if (state.weekCount === 0) return '沙盒季度未有任何週報';
        return 'Config 未設定 ' + CONFIG_KEYS.TEMPLATE_FILE_ID_NORMAL + ' 或者 '
          + CONFIG_KEYS.BULLETIN_OUTPUT_FOLDER_ID;
      },
      run: function (ctx) {
        var dates = selfTestSandboxDates_(ctx.config);
        var isoDate = dates[ctx.random.nextInt(Math.min(dates.length, 3))];
        assertSelfTestWritableDate_(isoDate, ctx.config);

        var result = saveBulletinDocx_(isoDate);
        if (!result.ok) return monkeyStepResult_(false, '失敗：' + (result.message || result.reason));

        ctx.lastDocxFileId = result.file.fileId;
        var assertion = assertDocxOutput_(result.file.fileId);
        return monkeyStepResult_(true, '主日 ' + isoDate + '，殘留佔位符 '
          + (assertion.ok ? assertion.residualPlaceholders : '（驗不到）'));
      }
    },
    {
      id: 'PUBLISH',
      label: '發佈（沙盒 master 檔案）',
      available: function (state) { return state.weekCount > 0 && state.hasSandboxMaster; },
      unavailableReason: function (state) {
        if (state.weekCount === 0) return '沙盒季度未有任何週報';
        // ⚠️ 一定要講明是這個原因，不可以靜靜由候選清單剔走——PUBLISH 是
        //    整個系統副作用最大的動作，它零次被揀中一定要有人見到理由。
        return 'Config 的 ' + CONFIG_KEYS.SELFTEST_MASTER_PDF_FILE_ID
          + ' 是空的（亂行機絕對不會碰 ' + CONFIG_KEYS.PUBLISHED_PDF_FILE_ID + '）';
      },
      run: function (ctx) {
        var dates = selfTestSandboxDates_(ctx.config);
        var isoDate = dates[ctx.random.nextInt(Math.min(dates.length, 3))];
        assertSelfTestWritableDate_(isoDate, ctx.config);

        var pdf = selfTestMakePdfBlob_('monkey ' + ctx.runId + '-' + ctx.stepNo);
        var result = selfTestRunPublish_(ctx.config, {
          isoDate: isoDate, doPublish: true, doSend: false,
          pdfBase64: Utilities.base64Encode(pdf.getBytes()),
          pdfName: 'monkey.pdf', confirmed: true
        });

        // ⚠️ 被防重複／揀錯檔案擋住**不算失敗**——那是系統正確地拒絕，
        // 正是它應該做的事。只有拋錯或者出現不變量問題才算紅。
        if (!result.ok) return monkeyStepResult_(true, '被拒（' + result.reason + '），這是預期之內的保護');
        return monkeyStepResult_(true, '發佈了第 ' + result.published.versionNo + ' 版');
      }
    },
    {
      id: 'SEND_DRY_RUN',
      label: '寄出（試行）',
      available: function (state) { return state.weekCount > 0 && state.hasRecipients; },
      unavailableReason: function (state) {
        if (state.weekCount === 0) return '沙盒季度未有任何週報';
        return state.recipientsReason || 'Recipients 沒有任何符合 SEND_GROUPS 的有效收件人';
      },
      run: function (ctx) {
        // ⚠️ 再斷言一次：這一步是整個亂行機唯一會叫 MailApp 的地方。
        monkeyAssertDryRun_();

        var dates = selfTestSandboxDates_(ctx.config);
        var isoDate = dates[ctx.random.nextInt(Math.min(dates.length, 3))];
        assertSelfTestWritableDate_(isoDate, ctx.config);

        var sent = sendBulletinForDate_(isoDate);
        return monkeyStepResult_(true, '主日 ' + isoDate + '，試行 ' + sent.dryRun
          + '，收件人 ' + (sent.recipientCount || 0));
      }
    },
    {
      id: 'RESEQUENCE',
      label: '整理清單次序',
      available: function (state) { return state.announcementCount > 0; },
      unavailableReason: function () { return '沙盒季度的家事報告一條都沒有，沒有次序可以整理'; },
      run: function (ctx) {
        assertSelfTestWritableQuarter_(ctx.config.quarterId, ctx.config);
        var result = resequenceQuarterLists_(ctx.config.quarterId);
        return monkeyStepResult_(true, '整理了 ' + (result.totalChanged || 0) + ' 行');
      }
    }
  ];
}

/**
 * 用途：由一批不成立的不變量取出它們的編號。
 *
 *   ⚠️ 抽成一支函式，是因為那個屬性名剛好撞正一個真實頂層網域，直接寫在
 *   字串拼接中間會被 `tools/scan-staged-secrets.js` 的網域偵測誤判
 *   （同 docs/已知bug類型.md 事故六那一類）。不應該為了遷就命名而放寬
 *   掃描器。
 * Args:
 *   failures {Object[]} `runAllInvariants_().failed`。
 * Returns:
 *   {string[]}
 */
function invariantFailureIds_(failures) {
  return (failures || []).map(function (f) { return f.id; });
}

/**
 * 用途：組出一步的結果。
 * Args:
 *   ok {boolean} 這一步本身有沒有做得成。
 *   detail {string} 一句說明。
 * Returns:
 *   {{ok:boolean, detail:string}}
 */
function monkeyStepResult_(ok, detail) {
  return { ok: ok === true, detail: String(detail || '') };
}

/**
 * 用途：斷言 `DRY_RUN` 仍然是 `TRUE`，否則拋錯。
 *
 *   ⚠️ 開跑前斷言一次不夠：亂行機會跑幾十步、幾分鐘，中途有人改 Config
 *   是完全有可能的。每 `MONKEY_DRY_RUN_RECHECK_EVERY_` 步、以及每一次
 *   真的要寄信之前，都要再斷言一次。
 * Args: （無）
 * Returns:
 *   {void}
 * Raises:
 *   Error 如果 `DRY_RUN` 不是 `TRUE`。
 */
function monkeyAssertDryRun_() {
  clearConfigCache_();
  if (normalizeBoolean_(getConfig(CONFIG_KEYS.DRY_RUN, 'TRUE')) !== true) {
    throw new Error('亂行機中止：DRY_RUN 已經不是 TRUE。'
      + '亂行機會真的走寄出流程，DRY_RUN=FALSE 之下那些信會真的寄出去。');
  }
}

/**
 * 用途：算出「現在的狀態」——決定哪些動作合法。**唯讀。**
 * Args:
 *   config {Object} `selfTestConfig_()` 的回傳值。
 * Returns:
 *   {{weekCount:number, announcementCount:number, hasContentFolder:boolean,
 *     hasContentSheet:boolean, hasSandboxMaster:boolean, canRenderDocx:boolean,
 *     hasRecipients:boolean}}
 */
function monkeyCurrentState_(config) {
  var sandboxDates = selfTestSandboxDates_(config);

  var weekCount = readSheet(SHEETS.BULLETIN_WEEKS).filter(function (r) {
    return String(r.QUARTER_ID || '').trim() === config.quarterId;
  }).length;

  // ⚠️ 拿不到的時候要**記低原因**。靜靜當成 false 的話，WRITE_CONTENT 與
  //    IMPORT_CONTENT 會由候選清單消失，而報告完全講不出為甚麼。
  var hasContentSheet = false;
  var contentSheetReason = '';
  try {
    hasContentSheet = Boolean(findContentSheetRow_(config.quarterId));
    if (!hasContentSheet) contentSheetReason = '沙盒季度未有內容表（要先建立）';
  } catch (err) {
    hasContentSheet = false;
    contentSheetReason = '讀內容表登記時拋錯：' + ((err && err.message) ? err.message : String(err));
  }

  var hasRecipients = false;
  var recipientsReason = '';
  try {
    hasRecipients = buildRecipientList_(readSheet(SHEETS.RECIPIENTS),
      getConfigTextList_(CONFIG_KEYS.SEND_GROUPS, 'CC,DB,ADMIN'), null).recipients.length > 0;
    if (!hasRecipients) recipientsReason = 'Recipients 沒有任何符合 SEND_GROUPS 的有效收件人';
  } catch (err2) {
    hasRecipients = false;
    recipientsReason = '算收件人時拋錯：' + ((err2 && err2.message) ? err2.message : String(err2));
  }

  return {
    weekCount: weekCount,
    announcementCount: selfTestCountActive_(SHEETS.ANNOUNCEMENTS, sandboxDates),
    hasContentFolder: Boolean(config.contentFolderId),
    hasContentSheet: hasContentSheet,
    contentSheetReason: contentSheetReason,
    hasSandboxMaster: Boolean(config.masterFileId),
    canRenderDocx: Boolean(getConfig(CONFIG_KEYS.TEMPLATE_FILE_ID_NORMAL, ''))
      && Boolean(getConfig(CONFIG_KEYS.BULLETIN_OUTPUT_FOLDER_ID, '')),
    hasRecipients: hasRecipients,
    recipientsReason: recipientsReason
  };
}

// =====================================================================
// 續跑狀態（MonkeyState）
// =====================================================================

/** `MonkeyState.STATUS` 的取值。 */
var MONKEY_RUN_STATUS_ = Object.freeze({ PAUSED: 'PAUSED', DONE: 'DONE' });

/**
 * 用途：把這一批跑完之後的狀態記入 `MonkeyState`。**不刪行，只新增**——
 *   每一批一行，最新那一行就是那一次執行目前的狀態。
 * Args:
 *   state {{runId:string, seed:number, targetSteps:number, stepsDone:number,
 *           rngState:number, status:string, startedAt:Date, notes:string}}
 * Returns:
 *   {void}
 */
function monkeyWriteStateRow_(state) {
  writeSheet(SHEETS.MONKEY_STATE, [{
    RUN_ID: sanitizeCellText_(state.runId),
    SEED: sanitizeCellText_(String(state.seed)),
    TARGET_STEPS: Number(state.targetSteps),
    STEPS_DONE: Number(state.stepsDone),
    RNG_STATE: sanitizeCellText_(String(state.rngState)),
    STATUS: sanitizeCellText_(state.status),
    STARTED_AT: state.startedAt,
    UPDATED_AT: new Date(),
    NOTES: sanitizeCellText_(state.notes || '')
  }]);
}

/**
 * 用途：讀出「最近一次尚未跑完」的亂行執行。
 *
 *   ⚠️ 只看**最後一行**：每一批都會新增一行，所以最後一行就是最近一次
 *   執行的目前狀態。如果它已經 `DONE`，就代表沒有未完成的執行——
 *   **不可以往上找一個更舊的 `PAUSED`**，那一輪的沙盒狀態早就被後來那一輪
 *   改過了，接住走沒有意義。
 * Args: （無）
 * Returns:
 *   {?{runId:string, seed:number, targetSteps:number, stepsDone:number,
 *      rngState:number, startedAt:*}} 沒有未完成的執行回 `null`。
 */
function monkeyLatestPausedState_() {
  var rows = readSheet(SHEETS.MONKEY_STATE);
  if (rows.length === 0) return null;

  var last = rows[rows.length - 1];
  if (String(last.STATUS || '').trim() !== MONKEY_RUN_STATUS_.PAUSED) return null;

  var runId = String(last.RUN_ID || '').trim();
  if (!runId) return null;

  return {
    runId: runId,
    seed: Number(String(last.SEED || '0').trim()),
    targetSteps: Number(last.TARGET_STEPS || 0),
    stepsDone: Number(last.STEPS_DONE || 0),
    rngState: Number(String(last.RNG_STATE || '0').trim()),
    startedAt: last.STARTED_AT
  };
}

// =====================================================================
// 防打轉閘
// =====================================================================

/**
 * 用途：把沙盒目前的狀態縮成一個字串，用來判斷「這一步之後有沒有變過」。
 *
 *   ⚠️ 只數得到的東西才放得入去。數不到的（例如 Drive 檔案內容）不放——
 *   放一個「有時讀得到有時讀不到」的值入去，會令閘無故響或者永遠不響。
 * Args:
 *   config {Object} `selfTestConfig_()` 的回傳值。
 * Returns:
 *   {string}
 */
function monkeyStateFingerprint_(config) {
  var dates = selfTestSandboxDates_(config);
  var parts = [
    'weeks=' + readSheet(SHEETS.BULLETIN_WEEKS).filter(function (r) {
      return String(r.QUARTER_ID || '').trim() === config.quarterId;
    }).length,
    'ann=' + selfTestCountActive_(SHEETS.ANNOUNCEMENTS, dates),
    'pray=' + selfTestCountActive_(SHEETS.PRAYERS, dates),
    'fel=' + selfTestCountActive_(SHEETS.FELLOWSHIPS, dates),
    'fin=' + selfTestCountActive_(SHEETS.FINANCE, dates),
    'audit=' + readSheet(SHEETS.AUDIT_LOG).length,
    'send=' + readSheet(SHEETS.SEND_LOG).length,
    'publish=' + readSheet(SHEETS.PUBLISH_LOG).length
  ];
  return parts.join('|');
}

// =====================================================================
// 執行器
// =====================================================================

/**
 * 用途：亂行機的**真正入口**。
 *
 *   ⚠️ `resume: true` 的意思是「**接住上一次未完成那一輪繼續走**」：
 *   同一個 `RUN_ID`、同一個種子、還原亂數狀態、`STEP_NO` 由
 *   `STEPS_DONE + 1` 數起。沒有未完成的執行就**明確拒絕**，不會靜靜開新
 *   一輪——那正是修正之前的行為（見 docs/已知bug類型.md 事故三十四）。
 * Args:
 *   options {{steps:number=, seed:number=, resume:boolean=}=}
 *     `steps` 是**這一批**要走的步數（新一輪時同時當成目標步數）；
 *     `seed` 不提供時用時間戳記（一定會寫進報告，方便重跑同一條路）。
 * Returns:
 *   {{ok:boolean, message:string, runId:string, seed:number,
 *     steps:Object[], failedStep:?Object, stoppedForTime:boolean,
 *     requestedSteps:number, stepsDoneBefore:number, totalStepsDone:number,
 *     targetSteps:number, status:string, coverage:Object[],
 *     stoppedForNoProgress:boolean, resumed:boolean}}
 */
function runMonkey_(options) {
  var opts = options || {};
  var config = selfTestConfig_();

  var guard = assertSelfTestSandbox_(config);
  if (!guard.ok) return monkeyRefused_(guard.message);

  var actions = monkeyActions_();
  var startedAt = new Date();
  var runId;
  var seed;
  var savedRngState = null;
  var stepsDoneBefore = 0;
  var targetSteps;
  var batchSteps;

  if (opts.resume === true) {
    var pending = monkeyLatestPausedState_();
    if (!pending) {
      // ⚠️ 不可以靜靜開新一輪：使用者以為自己在續跑，實際上每一次都由頭
      //    開始，目標步數永遠跑不滿——而且完全沒有提示。
      return monkeyRefused_('沒有未完成的執行，請先撳〔跑亂行機〕。'
        + '（〔繼續亂行〕只會接住上一次未跑完那一輪；'
        + '上一次如果已經跑滿目標步數，就沒有東西可以接。）');
    }
    runId = pending.runId;
    seed = pending.seed;
    savedRngState = pending.rngState;
    stepsDoneBefore = pending.stepsDone;
    targetSteps = pending.targetSteps;
    startedAt = normalizeDate_(pending.startedAt) || startedAt;
    batchSteps = Math.max(0, targetSteps - stepsDoneBefore);
    if (batchSteps === 0) {
      return monkeyRefused_('上一次已經走滿 ' + targetSteps + ' 步，沒有東西可以接。');
    }
  } else {
    var requested = Number(opts.steps) > 0 ? Math.floor(Number(opts.steps)) : 50;
    var timezone = getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland');
    runId = 'MK' + Utilities.formatDate(startedAt, timezone, 'yyyyMMddHHmmss');
    seed = Number(opts.seed) > 0 ? Math.floor(Number(opts.seed)) : (startedAt.getTime() % 4294967296);
    targetSteps = requested;
    batchSteps = requested;
  }

  var random = monkeyRandom_(seed, savedRngState);
  var ctx = {
    config: config,
    runId: runId,
    random: random,
    rosterRevisionBaseline: driveCountRevisions_(getConfig(CONFIG_KEYS.ROSTER_SPREADSHEET_ID, '')),
    startMs: new Date().getTime(),
    stepNo: stepsDoneBefore
  };

  var noProgressLimit = normalizeInt_(getConfig(CONFIG_KEYS.MONKEY_NO_PROGRESS_LIMIT, '5'));
  if (!noProgressLimit || noProgressLimit < 1) noProgressLimit = 5;

  var pathSoFar = [];
  var steps = [];
  var failedStep = null;
  var stoppedForTime = false;
  var stoppedForNoProgress = false;
  var coverage = monkeyNewCoverage_(actions);
  var lastFingerprint = monkeyStateFingerprint_(config);
  var noProgressRun = 0;

  for (var offset = 1; offset <= batchSteps; offset++) {
    var stepNo = stepsDoneBefore + offset;

    if (new Date().getTime() - ctx.startMs > config.timeBudgetMs) {
      stoppedForTime = true;
      break;
    }
    if (offset % MONKEY_DRY_RUN_RECHECK_EVERY_ === 1) monkeyAssertDryRun_();

    ctx.stepNo = stepNo;
    var state = monkeyCurrentState_(config);
    var split = monkeySplitActions_(actions, state);

    // ⚠️ 不合法的動作要**記低原因**，不是靜靜由候選清單剔走。零次被揀中
    //    的動作，究竟是「揀不到」還是「根本沒有資格」，是兩件事。
    split.unavailable.forEach(function (item) {
      monkeyMarkNotApplicable_(coverage, item.id, item.reason);
    });

    if (split.available.length === 0) {
      steps.push({
        stepNo: stepNo, availableIds: [], chosenId: '（沒有合法動作）',
        result: MONKEY_STEP_RESULT_.SKIPPED, detail: '目前狀態下沒有任何合法動作。',
        invariantStatus: '（未檢查）', pathSoFar: pathSoFar.join(' → '),
        invariantFailures: []
      });
      break;
    }

    var chosen = split.available[ctx.random.nextInt(split.available.length)];
    monkeyMarkChosen_(coverage, chosen.id);

    var stepResult;
    var threw = false;
    try {
      stepResult = chosen.run(ctx);
    } catch (err) {
      // ⚠️ 拋錯要**記入紀錄並繼續**，不可以靜靜重揀一個。靜靜重揀的話，
      //    那個動作會永遠零次被揀中，而錯誤完全消失。
      threw = true;
      // ⚠️ 先取出成獨立變數：夾在引號之間的屬性存取，如果屬性名剛好是一個
      //    真實的 gTLD（id、name……），會被 tools/scan-staged-secrets.js 誤判
      //    成網域，見 docs/已知bug類型.md 事故六。
      var chosenActionId = chosen.id;
      stepResult = monkeyStepResult_(false,
        '拋出例外：' + ((err && err.message) ? err.message : String(err))
        + '　' + buildErrorDetail_(err, { argsSummary: 'action=' + chosenActionId + ' step=' + stepNo }));
    }

    pathSoFar.push(chosen.label);

    // ⚠️ 每一步跑完檢查一次全部不變量——亂行機的價值全在這裡。
    var invariants = runAllInvariants_({
      quarterId: config.quarterId,
      isoDate: selfTestSandboxDates_(config)[0] || '',
      docxFileId: ctx.lastDocxFileId,
      rosterRevisionBaseline: ctx.rosterRevisionBaseline
    });

    var record = {
      stepNo: stepNo,
      availableIds: split.available.map(function (a) { return a.id; }),
      chosenId: chosen.id,
      chosenLabel: chosen.label,
      result: stepResult.ok ? MONKEY_STEP_RESULT_.OK : MONKEY_STEP_RESULT_.FAILED,
      threw: threw,
      detail: stepResult.detail,
      invariantStatus: invariants.failedCount === 0
        ? ('全部通過（' + invariants.unknownCount + ' 條驗證不到）')
        : ('不成立：' + invariantFailureIds_(invariants.failed).join('、')),
      invariantFailures: invariants.failed,
      pathSoFar: pathSoFar.join(' → ')
    };
    steps.push(record);
    monkeyWriteLogRow_(runId, seed, record);

    if (invariants.failedCount > 0) {
      record.result = MONKEY_STEP_RESULT_.FAILED;
      failedStep = record;
      break;
    }

    // ---- 防打轉閘 ----
    var fingerprint = monkeyStateFingerprint_(config);
    if (fingerprint === lastFingerprint) {
      noProgressRun++;
      if (noProgressRun >= noProgressLimit) {
        stoppedForNoProgress = true;
        record.detail += '　⚠️ 連續 ' + noProgressRun + ' 步狀態完全沒有變。';
        break;
      }
    } else {
      noProgressRun = 0;
      lastFingerprint = fingerprint;
    }
  }

  var totalStepsDone = stepsDoneBefore + steps.length;
  var status = (totalStepsDone >= targetSteps && !failedStep && !stoppedForNoProgress)
    ? MONKEY_RUN_STATUS_.DONE : MONKEY_RUN_STATUS_.PAUSED;

  monkeyWriteStateRow_({
    runId: runId, seed: seed, targetSteps: targetSteps, stepsDone: totalStepsDone,
    rngState: random.state(), status: status, startedAt: startedAt,
    notes: monkeyStateNotes_(failedStep, stoppedForTime, stoppedForNoProgress, noProgressLimit)
  });

  var summary = {
    ok: true, message: '', runId: runId, seed: seed,
    steps: steps, failedStep: failedStep,
    stoppedForTime: stoppedForTime, stoppedForNoProgress: stoppedForNoProgress,
    requestedSteps: batchSteps,
    stepsDoneBefore: stepsDoneBefore, totalStepsDone: totalStepsDone,
    targetSteps: targetSteps, status: status,
    coverage: monkeyCoverageList_(coverage),
    resumed: opts.resume === true,
    noProgressLimit: noProgressLimit
  };
  writeDiagnosticsReport_('亂行機報告', buildMonkeyReportLines_(summary));
  return summary;
}

/**
 * 用途：砌一個「沒有開跑」的回傳值。**純函式。**
 * Args:
 *   message {string} 原因。
 * Returns:
 *   {Object}
 */
function monkeyRefused_(message) {
  return {
    ok: false, message: message, runId: '', seed: 0,
    steps: [], failedStep: null, stoppedForTime: false, stoppedForNoProgress: false,
    requestedSteps: 0, stepsDoneBefore: 0, totalStepsDone: 0, targetSteps: 0,
    status: '', coverage: [], resumed: false
  };
}

/**
 * 用途：把動作分成「現在合法」與「現在不合法（連原因）」兩堆。**純函式。**
 *
 *   ⚠️ 不合法的那一堆一定要帶**原因**。修正之前只做 `filter`，於是報告
 *   只講得出「候選有邊幾個」，講不出「其餘那幾個為甚麼不在」——零次被
 *   揀中的動作到底是揀不到還是無資格，分不出來。
 * Args:
 *   actions {Object[]} `monkeyActions_()`。
 *   state {Object} `monkeyCurrentState_()`。
 * Returns:
 *   {{available:Object[], unavailable:{id:string, reason:string}[]}}
 */
function monkeySplitActions_(actions, state) {
  var available = [];
  var unavailable = [];
  (actions || []).forEach(function (action) {
    if (action.available(state)) {
      available.push(action);
      return;
    }
    unavailable.push({
      id: action.id,
      reason: action.unavailableReason ? action.unavailableReason(state) : '（沒有講明原因）'
    });
  });
  return { available: available, unavailable: unavailable };
}

/**
 * 用途：造一個「每個動作 0 次」的覆蓋統計表。**純函式。**
 * Args:
 *   actions {Object[]}
 * Returns:
 *   {Object<string,{id:string, label:string, chosen:number, reasons:Object}>}
 */
function monkeyNewCoverage_(actions) {
  var out = {};
  (actions || []).forEach(function (action) {
    out[action.id] = { id: action.id, label: action.label, chosen: 0, reasons: {} };
  });
  return out;
}

/** 記一次「被揀中」。 */
function monkeyMarkChosen_(coverage, actionId) {
  if (coverage[actionId]) coverage[actionId].chosen++;
}

/** 記一次「不適用」連原因。同一個原因只記一次。 */
function monkeyMarkNotApplicable_(coverage, actionId, reason) {
  if (!coverage[actionId]) return;
  coverage[actionId].reasons[String(reason || '（沒有講明原因）')] = true;
}

/**
 * 用途：把覆蓋統計排成一個陣列，方便報告與測試用。**純函式。**
 * Args:
 *   coverage {Object}
 * Returns:
 *   {{id:string, label:string, chosen:number, notApplicableReasons:string[]}[]}
 */
function monkeyCoverageList_(coverage) {
  return Object.keys(coverage).map(function (actionId) {
    var entry = coverage[actionId];
    return {
      id: entry.id,
      label: entry.label,
      chosen: entry.chosen,
      notApplicableReasons: Object.keys(entry.reasons)
    };
  });
}

/**
 * 用途：`MonkeyState.NOTES` 那一句。**純函式。**
 * Args:
 *   failedStep {?Object}　stoppedForTime {boolean}
 *   stoppedForNoProgress {boolean}　noProgressLimit {number}
 * Returns:
 *   {string}
 */
function monkeyStateNotes_(failedStep, stoppedForTime, stoppedForNoProgress, noProgressLimit) {
  if (failedStep) return '第 ' + failedStep.stepNo + ' 步之後不變量不成立，已停手。';
  if (stoppedForNoProgress) return '連續 ' + noProgressLimit + ' 步狀態完全沒有變，防打轉閘停手。';
  if (stoppedForTime) return '執行時間到，乾淨停低。';
  return '';
}

/**
 * 用途：把一步寫入 `MonkeyLog`。
 * Args:
 *   runId {string}　seed {number}　record {Object}
 * Returns:
 *   {void}
 */
function monkeyWriteLogRow_(runId, seed, record) {
  writeSheet(SHEETS.MONKEY_LOG, [{
    RUN_ID: sanitizeCellText_(runId),
    SEED: sanitizeCellText_(String(seed)),
    STEP_NO: Number(record.stepNo),
    AVAILABLE_ACTIONS: sanitizeCellText_(record.availableIds.join('、')),
    CHOSEN_ACTION: sanitizeCellText_(record.chosenLabel || record.chosenId),
    RESULT: sanitizeCellText_(record.result + '：' + record.detail),
    INVARIANT_STATUS: sanitizeCellText_(record.invariantStatus),
    PATH_SO_FAR: sanitizeCellText_(record.pathSoFar),
    TIMESTAMP: new Date()
  }]);
}

/**
 * 用途：把亂行結果排版成報告內容行。**純函式。**
 *
 *   ⚠️ 種子寫在**報告開頭**——沒有它，紅了也重現不到，整個第 3 層就
 *   白費。
 * Args:
 *   summary {Object} `runMonkey_()` 的回傳值。
 * Returns:
 *   {string[]}
 */
function buildMonkeyReportLines_(summary) {
  if (!summary.ok) return ['亂行機沒有開跑：' + summary.message];

  var lines = [];
  lines.push('亂行機：' + monkeyProgressPhrase_(summary));
  lines.push('亂數種子：' + summary.seed + '　（用同一個種子由乾淨狀態重跑，會走同一條路）');
  lines.push('執行編號：' + summary.runId + (summary.resumed ? '　（這一批是續跑）' : ''));

  if (summary.failedStep) {
    var f = summary.failedStep;
    lines.push('');
    lines.push('🔴 第 ' + f.stepNo + ' 步之後，不變量不成立');
    f.invariantFailures.forEach(function (inv) {
      var invariantId = inv.id;
      lines.push('　　' + invariantId + '　預期：' + inv.expected + '　實際：' + inv.actual);
      lines.push('　　　　證據：' + inv.evidence);
    });
    lines.push('');
    lines.push('　　走到這裏的完整步驟：' + f.pathSoFar);
    lines.push('　　（用種子 ' + summary.seed + ' 由乾淨狀態重跑就會再走同一條路）');
  } else if (summary.stoppedForNoProgress) {
    lines.push('');
    lines.push('⚠️ 偵測到原地打轉：連續 ' + summary.noProgressLimit
      + ' 步狀態完全沒有變，已經停手。');
    lines.push('　　繼續走下去只會不停重覆同一批動作，抓不到新的東西。');
    lines.push('　　通常代表目前合法的動作全部都是唯讀的，或者它們寫入的值與現況相同。');
  } else if (summary.stoppedForTime) {
    lines.push('');
    lines.push('⚠️ 執行時間到，已經乾淨停低（這一批走了 ' + summary.steps.length + ' 步）。'
      + '請執行〔繼續亂行〕接住走。');
  } else if (summary.status === MONKEY_RUN_STATUS_.DONE) {
    lines.push('');
    lines.push('✅ 已完成 ' + summary.totalStepsDone + '／' + summary.targetSteps
      + ' 步，每一步之後不變量都成立。');
  } else {
    lines.push('');
    lines.push('✅ 這一批走完，每一步之後不變量都成立。請執行〔繼續亂行〕接住走。');
  }

  lines.push('');
  lines.push(monkeyCoverageHeadline_(summary.coverage));
  monkeyCoverageProblemLines_(summary.coverage).forEach(function (line) { lines.push(line); });

  lines.push('');
  lines.push('【逐步記錄】');
  summary.steps.forEach(function (s) {
    lines.push('第 ' + s.stepNo + ' 步　合法：[' + s.availableIds.join(', ') + ']　'
      + '揀了：' + (s.chosenLabel || s.chosenId));
    lines.push('　　結果：' + s.result + '　' + s.detail);
    lines.push('　　不變量：' + s.invariantStatus);
  });

  return lines;
}

/**
 * 用途：把進度講成一句「走了 14／20 步（本批 5 步）」。**純函式。**
 *
 *   ⚠️ 一定要顯示**累計**。只顯示本批步數的話，續跑三次每次都寫「走了
 *   9 步」，看的人完全不知道目標 20 步從來沒有跑滿過——那正是修正之前
 *   的情況。
 * Args:
 *   summary {Object}
 * Returns:
 *   {string}
 */
function monkeyProgressPhrase_(summary) {
  var text = '走了 ' + summary.totalStepsDone + '／' + summary.targetSteps + ' 步';
  if (summary.stepsDoneBefore > 0) {
    text += '（本批 ' + summary.steps.length + ' 步）';
  }
  return text;
}

/**
 * 用途：覆蓋統計那一行。**純函式。**
 * Args:
 *   coverage {Object[]} `monkeyCoverageList_()` 的輸出。
 * Returns:
 *   {string}
 */
function monkeyCoverageHeadline_(coverage) {
  var chosen = (coverage || []).filter(function (c) { return c.chosen > 0; })
    .sort(function (a, b) { return b.chosen - a.chosen; })
    .map(function (c) { return c.id + ' ' + c.chosen; });
  return '動作覆蓋：' + (chosen.length > 0 ? chosen.join('、') : '（一個都沒有揀過）');
}

/**
 * 用途：覆蓋統計裏面**要有人看**的那幾行——零次被揀中、以及不適用的原因。
 *
 *   ⚠️ 零次被揀中的動作一定要**明確標出**。不標的話，一個從來沒有跑過的
 *   動作看起來與「跑過而且沒事」一模一樣。
 *   ⚠️ 「從未揀中」與「不適用」是兩件事：前者是有資格但抽不中（可能是
 *   亂數有問題），後者是根本沒有資格（前置條件未滿足）。分開講。
 * Args:
 *   coverage {Object[]}
 * Returns:
 *   {string[]}
 */
function monkeyCoverageProblemLines_(coverage) {
  var lines = [];
  var list = coverage || [];

  var notApplicable = list.filter(function (c) {
    return c.chosen === 0 && c.notApplicableReasons.length > 0;
  });
  var neverChosen = list.filter(function (c) {
    return c.chosen === 0 && c.notApplicableReasons.length === 0;
  });

  if (neverChosen.length > 0) {
    lines.push('⚠️ 從未揀中（有資格但一次都抽不中）：'
      + neverChosen.map(function (c) { return c.id; }).join('、'));
  }
  notApplicable.forEach(function (entry) {
    // ⚠️ 同上，先取出成獨立變數（事故六）。
    var actionId = entry.id;
    lines.push('⚠️ 不適用（未進入候選）：' + actionId + '——' + entry.notApplicableReasons.join('；'));
  });

  if (lines.length === 0) {
    lines.push('（每一個動作都至少被揀中過一次。）');
  }
  return lines;
}

/**
 * 用途：把亂行結果縮成對話框摘要。**純函式。**
 * Args:
 *   summary {Object} `runMonkey_()` 的回傳值。
 * Returns:
 *   {string}
 */
function buildMonkeyShortSummary_(summary) {
  if (!summary.ok) return summary.message;

  var lines = ['亂行機：' + monkeyProgressPhrase_(summary),
    '執行編號：' + summary.runId + '　亂數種子：' + summary.seed];

  if (summary.failedStep) {
    var f = summary.failedStep;
    lines.push('');
    lines.push('🔴 第 ' + f.stepNo + ' 步之後不變量不成立：'
      + invariantFailureIds_(f.invariantFailures).join('、'));
    f.invariantFailures.forEach(function (inv) {
      var invariantId = inv.id;
      lines.push('　' + invariantId + '　預期 ' + inv.expected + '，實際 ' + inv.actual);
    });
    lines.push('');
    lines.push('走到這裏的完整步驟：');
    lines.push('　' + f.pathSoFar);
  } else if (summary.stoppedForNoProgress) {
    lines.push('');
    lines.push('⚠️ 偵測到原地打轉：連續 ' + summary.noProgressLimit + ' 步狀態完全沒有變，已停手。');
  } else if (summary.stoppedForTime) {
    lines.push('');
    lines.push('⚠️ 執行時間到，已停低。請執行〔繼續亂行〕接住走。');
  } else if (summary.status === MONKEY_RUN_STATUS_.DONE) {
    lines.push('');
    lines.push('✅ 已完成 ' + summary.totalStepsDone + '／' + summary.targetSteps + ' 步。');
  } else {
    lines.push('');
    lines.push('✅ 這一批走完。請執行〔繼續亂行〕接住走。');
  }

  lines.push('');
  lines.push(monkeyCoverageHeadline_(summary.coverage));
  monkeyCoverageProblemLines_(summary.coverage).forEach(function (line) { lines.push(line); });

  lines.push('');
  lines.push('完整記錄見 MonkeyLog 工作表與 Diagnostics 的「亂行機報告」。');
  return lines.join('\n');
}

// =====================================================================
// 選單
// =====================================================================

/**
 * 用途：選單項目「⚠️ 亂行機（沙盒季度，DRY_RUN）」的處理函式——**開新一輪**。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuRunMonkey_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var config = selfTestConfig_();
    var resp = ui.prompt('亂行機（沙盒季度，DRY_RUN）',
      '亂行機會在沙盒季度（' + config.quarterId + '）內隨機執行合法動作，'
      + '每一步之後檢查一次全部不變量。\n\n'
      + '目前 DRY_RUN＝' + (config.dryRun ? 'TRUE（不會真的寄出）' : 'FALSE（⚠️ 會真的寄出）') + '\n\n'
      + '⚠️ 這是**開新一輪**（新的執行編號與種子）。要接住上一次未跑完那一輪，'
      + '請撳〔繼續亂行〕。\n\n'
      + '目標走幾多步？（直接按確定＝50 步）',
      ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    var steps = normalizeInt_(resp.getResponseText().trim());
    var summary = runMonkey_({ steps: (steps === null || steps <= 0) ? 50 : steps });
    ui.alert('亂行機', buildMonkeyShortSummary_(summary), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuRunMonkey_', err);
    ui.alert('亂行機失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：選單項目「繼續亂行」的處理函式——**接住上一次未跑完那一輪**。
 *
 *   ⚠️ 修正之前這一支只是再叫一次 `runMonkey_()`：新的執行編號、新的
 *   種子、`STEP_NO` 由 1 數起。使用者撳三次，以為走了三段，實際上是三個
 *   互不相干的短程，目標步數從來沒有跑滿過——而且完全沒有提示。
 *   見 docs/已知bug類型.md 事故三十四。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuResumeMonkey_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var pending = monkeyLatestPausedState_();
    if (!pending) {
      ui.alert('繼續亂行',
        '沒有未完成的執行，請先撳〔跑亂行機〕。\n\n'
          + '（〔繼續亂行〕只會接住上一次未跑完那一輪；'
          + '上一次如果已經跑滿目標步數，就沒有東西可以接。）',
        ui.ButtonSet.OK);
      return;
    }

    var remaining = Math.max(0, pending.targetSteps - pending.stepsDone);
    var answer = ui.alert('繼續亂行',
      '接住上一次那一輪繼續走：\n\n'
        + '　執行編號：' + pending.runId + '\n'
        + '　亂數種子：' + pending.seed + '\n'
        + '　進度：' + pending.stepsDone + '／' + pending.targetSteps + ' 步，還有 ' + remaining + ' 步\n\n'
        + '⚠️ 同一個執行編號、同一個種子、亂數狀態還原——揀中的動作序列會與'
        + '「一次過跑滿」完全相同。\n\n'
        + '要繼續嗎？',
      ui.ButtonSet.YES_NO);
    if (answer !== ui.Button.YES) return;

    var summary = runMonkey_({ resume: true });
    ui.alert('繼續亂行', buildMonkeyShortSummary_(summary), ui.ButtonSet.OK);
  } catch (err) {
    logMenuError_('menuResumeMonkey_', err);
    ui.alert('繼續亂行失敗', enrichAuthError_(err), ui.ButtonSet.OK);
  }
}

/**
 * 用途：讀出最近一次亂行的種子。
 * Args: （無）
 * Returns:
 *   {string} 沒有記錄回空字串。
 */
function monkeyLatestSeed_() {
  var rows = readSheet(SHEETS.MONKEY_LOG);
  if (rows.length === 0) return '';
  return String(rows[rows.length - 1].SEED || '');
}
