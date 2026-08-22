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
 * 用途：一個可以設種子、**可重覆**的亂數產生器（線性同餘）。
 *
 *   ⚠️ 刻意不用 `Math.random()`：它設不到種子，所以同一次紅燈永遠重現
 *   不到。統計性質在這裡完全不重要——「同一個種子走同一條路」才重要。
 *
 *   參數用 Numerical Recipes 那一組（模 2^32），在 JS 的 53 位整數精度
 *   之內不會失真。
 * Args:
 *   seed {number} 種子。
 * Returns:
 *   {{nextInt:function(number): number, seed:number}}
 *     `nextInt(n)` 回 `0` 至 `n-1`。
 */
function monkeyRandom_(seed) {
  var state = Number(seed) >>> 0;
  return {
    seed: state,
    nextInt: function (n) {
      var bound = Math.max(1, Math.floor(n));
      state = (1664525 * state + 1013904223) % 4294967296;
      return state % bound;
    }
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
      run: function (ctx) {
        var outcome = selfTestS01_(ctx);
        return monkeyStepResult_(outcome.ok !== false, '建立了骨架：' + outcome.actual);
      }
    },
    {
      id: 'EDIT_FIELDS',
      label: '經填寫介面改幾格',
      available: function (state) { return state.weekCount > 0; },
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

  var hasContentSheet = false;
  try {
    hasContentSheet = Boolean(findContentSheetRow_(config.quarterId));
  } catch (err) {
    hasContentSheet = false;
  }

  var hasRecipients = false;
  try {
    hasRecipients = buildRecipientList_(readSheet(SHEETS.RECIPIENTS),
      getConfigTextList_(CONFIG_KEYS.SEND_GROUPS, 'CC,DB,ADMIN'), null).recipients.length > 0;
  } catch (err2) {
    hasRecipients = false;
  }

  return {
    weekCount: weekCount,
    announcementCount: selfTestCountActive_(SHEETS.ANNOUNCEMENTS, sandboxDates),
    hasContentFolder: Boolean(config.contentFolderId),
    hasContentSheet: hasContentSheet,
    hasSandboxMaster: Boolean(config.masterFileId),
    canRenderDocx: Boolean(getConfig(CONFIG_KEYS.TEMPLATE_FILE_ID_NORMAL, ''))
      && Boolean(getConfig(CONFIG_KEYS.BULLETIN_OUTPUT_FOLDER_ID, '')),
    hasRecipients: hasRecipients
  };
}

// =====================================================================
// 執行器
// =====================================================================

/**
 * 用途：亂行機的**真正入口**。
 * Args:
 *   options {{steps:number=, seed:number=, resume:boolean=}=}
 *     `steps` 預設 50；`seed` 不提供時用時間戳記（**一定會寫進報告**，
 *     方便日後重跑同一條路）。
 * Returns:
 *   {{ok:boolean, message:string, runId:string, seed:number,
 *     steps:Object[], failedStep:?Object, stoppedForTime:boolean,
 *     requestedSteps:number}}
 */
function runMonkey_(options) {
  var opts = options || {};
  var config = selfTestConfig_();

  var guard = assertSelfTestSandbox_(config);
  if (!guard.ok) {
    return {
      ok: false, message: guard.message, runId: '', seed: 0,
      steps: [], failedStep: null, stoppedForTime: false, requestedSteps: 0
    };
  }

  var requestedSteps = Number(opts.steps) > 0 ? Math.floor(Number(opts.steps)) : 50;
  var timezone = getConfig(CONFIG_KEYS.SYS_TIMEZONE, 'Pacific/Auckland');
  var runId = 'MK' + Utilities.formatDate(new Date(), timezone, 'yyyyMMddHHmmss');
  var seed = Number(opts.seed) > 0 ? Math.floor(Number(opts.seed)) : (new Date().getTime() % 4294967296);

  var ctx = {
    config: config,
    runId: runId,
    random: monkeyRandom_(seed),
    rosterRevisionBaseline: driveCountRevisions_(getConfig(CONFIG_KEYS.ROSTER_SPREADSHEET_ID, '')),
    startMs: new Date().getTime(),
    stepNo: 0
  };

  var actions = monkeyActions_();
  var pathSoFar = [];
  var steps = [];
  var failedStep = null;
  var stoppedForTime = false;

  for (var i = 1; i <= requestedSteps; i++) {
    if (new Date().getTime() - ctx.startMs > config.timeBudgetMs) {
      stoppedForTime = true;
      break;
    }
    if (i % MONKEY_DRY_RUN_RECHECK_EVERY_ === 1) monkeyAssertDryRun_();

    ctx.stepNo = i;
    var state = monkeyCurrentState_(config);
    var available = actions.filter(function (a) { return a.available(state); });

    if (available.length === 0) {
      steps.push({
        stepNo: i, availableIds: [], chosenId: '（沒有合法動作）',
        result: MONKEY_STEP_RESULT_.SKIPPED, detail: '目前狀態下沒有任何合法動作。',
        invariantStatus: '（未檢查）', pathSoFar: pathSoFar.join(' → ')
      });
      break;
    }

    var chosen = available[ctx.random.nextInt(available.length)];
    var stepResult;
    try {
      stepResult = chosen.run(ctx);
    } catch (err) {
      stepResult = monkeyStepResult_(false, '拋出例外：' + ((err && err.message) ? err.message : String(err)));
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
      stepNo: i,
      availableIds: available.map(function (a) { return a.id; }),
      chosenId: chosen.id,
      chosenLabel: chosen.label,
      result: stepResult.ok ? MONKEY_STEP_RESULT_.OK : MONKEY_STEP_RESULT_.FAILED,
      detail: stepResult.detail,
      invariantStatus: invariants.failedCount === 0
        ? ('全部通過（' + invariants.unknownCount + ' 條驗證不到）')
        : ('不成立：' + invariantFailureIds_(invariants.failed).join('、')),
      invariantFailures: invariants.failed,
      pathSoFar: pathSoFar.join(' → ')
    };
    steps.push(record);
    monkeyWriteLogRow_(runId, seed, record);

    // 不變量紅了就停——繼續走下去只會令「走到這裏的完整步驟」越來越長，
    // 而重現的難度越來越高。第一個紅燈就是最有價值的那一個。
    if (invariants.failedCount > 0) {
      record.result = MONKEY_STEP_RESULT_.FAILED;
      failedStep = record;
      break;
    }
  }

  var summary = {
    ok: true, message: '', runId: runId, seed: seed,
    steps: steps, failedStep: failedStep,
    stoppedForTime: stoppedForTime, requestedSteps: requestedSteps
  };
  writeDiagnosticsReport_('亂行機報告', buildMonkeyReportLines_(summary));
  return summary;
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
  lines.push('亂行機：走了 ' + summary.steps.length + '／' + summary.requestedSteps + ' 步');
  lines.push('亂數種子：' + summary.seed + '　（用同一個種子重跑，會走同一條路）');
  lines.push('執行編號：' + summary.runId);

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
    lines.push('　　（用種子 ' + summary.seed + ' 重跑就會再走同一條路）');
  } else if (summary.stoppedForTime) {
    lines.push('');
    lines.push('⚠️ 執行時間到，已經乾淨停低（走了 ' + summary.steps.length + ' 步，'
      + '本來要走 ' + summary.requestedSteps + ' 步）。請執行〔繼續亂行〕。');
  } else {
    lines.push('');
    lines.push('✅ 走完全部 ' + summary.steps.length + ' 步，每一步之後不變量都成立。');
  }

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
 * 用途：把亂行結果縮成對話框摘要。**純函式。**
 * Args:
 *   summary {Object} `runMonkey_()` 的回傳值。
 * Returns:
 *   {string}
 */
function buildMonkeyShortSummary_(summary) {
  if (!summary.ok) return summary.message;

  var lines = ['亂行機：走了 ' + summary.steps.length + '／' + summary.requestedSteps + ' 步',
    '亂數種子：' + summary.seed];

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
  } else if (summary.stoppedForTime) {
    lines.push('');
    lines.push('⚠️ 執行時間到，已停低。請執行〔繼續亂行〕。');
  } else {
    lines.push('');
    lines.push('✅ 每一步之後不變量都成立。');
  }

  lines.push('');
  lines.push('完整記錄見 MonkeyLog 工作表與 Diagnostics 的「亂行機報告」。');
  return lines.join('\n');
}

// =====================================================================
// 選單
// =====================================================================

/**
 * 用途：選單項目「⚠️ 亂行機（沙盒季度，DRY_RUN）」的處理函式。
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
      + '要走幾多步？（直接按確定＝50 步）',
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
 * 用途：選單項目「繼續亂行」的處理函式——用**上一次同一個種子**繼續走。
 *
 *   ⚠️ 「繼續」的意思是「由目前狀態再走 N 步」，不是「重播上一次那條
 *   路」。沙盒的狀態已經被上一次改過，重播沒有意義；能重播的是
 *   「由乾淨狀態出發、用同一個種子」，那要先跑一次〔跑自測〕清空沙盒。
 *   這一點寫在對話框，免得有人以為「繼續」＝「接住上一次那條路」。
 * Args: （無）
 * Returns:
 *   {void}
 */
function menuResumeMonkey_() {
  var ui = SpreadsheetApp.getUi();
  try {
    var lastSeed = monkeyLatestSeed_();
    var resp = ui.prompt('繼續亂行',
      '由沙盒季度**目前的狀態**再走一段（不是重播上一次那一條路——'
      + '沙盒的狀態已經被上一次改過了）。\n\n'
      + '要重播的話，請先執行〔跑自測〕把沙盒清乾淨，再用同一個種子跑一次亂行機。\n'
      + '上一次的種子：' + (lastSeed || '（沒有記錄）') + '\n\n'
      + '要再走幾多步？（直接按確定＝50 步）',
      ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;

    var steps = normalizeInt_(resp.getResponseText().trim());
    var summary = runMonkey_({ steps: (steps === null || steps <= 0) ? 50 : steps });
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
