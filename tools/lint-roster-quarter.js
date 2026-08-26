#!/usr/bin/env node
/**
 * tools/lint-roster-quarter.js
 *
 * 靜態檢查：**「決定處理哪一季」的退回鏈，不可以用來決定「去職事表拿
 * 哪一季的資料」。**
 *
 * 執行方式：
 *   node tools/lint-roster-quarter.js
 *   node tools/lint-roster-quarter.js --json
 *
 * 離開碼：0＝沒有違規　1＝有違規
 *
 * ─────────────────────────────────────────────────────────────────────
 * 為什麼要有這一條（docs/已知bug類型.md 事故四十一）
 * ─────────────────────────────────────────────────────────────────────
 *
 * `resolveWorkingQuarter_()` 有一條四層退回鏈：Config 覆寫 → 下一個要寄的
 * 主日 → `ROSTER_TEST_DATE` → `BulletinWeeks` 最新一季。那條鏈的用途是
 * **「使用者沒有講，系統預設顯示哪一季」**——退不到就退，是方便。
 *
 * 但同一個值一旦被拿去讀職事表，性質就完全變了：
 *
 *   - 退回「哪一季顯示」→ 最壞情況是顯示了使用者不想要的一季，一眼看得出。
 *   - 退回「去職事表拿哪一季」→ **拿到的是別一季的真實人名**，而且看起來
 *     完全正常。幹事提早建立 2029T1，週報填上 2027 年的事奉名單，系統報
 *     「一切正常」。
 *
 * 這不是「缺失被當成正常」，是**錯的資料被當成正常**，嚴重一級。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 掃描兩條規則
 * ─────────────────────────────────────────────────────────────────────
 *
 * 1. 讀職事表的入口（見 ROSTER_READ_ENTRIES）不准**直接**收
 *    `resolveWorkingQuarter_()` 的結果。也就是說，以下這種寫法一律違規：
 *
 *      listRosterServiceDatesForQuarter_(resolveWorkingQuarter_().quarterId)
 *      readRosterSnapshot_(resolveWorkingQuarter_().isoDate)
 *
 *    正確做法是把退回鏈的結果**當成選單的預設值**顯示給人看、由人確認，
 *    再把確認過的季度傳下去。目前全部呼叫點都是這樣做的。
 *
 * 2. `resolveWorkingQuarter_()` 的結果，不准在同一支函式之內被送進讀職事表
 *    的入口。這一條抓的是分兩行寫的版本：
 *
 *      var r = resolveWorkingQuarter_();
 *      var dates = listQuarterServiceDates_(r.quarterId);      // ← 違規
 *
 *    ⚠️ 例外：檔案內只要那一行（或上一行）有 `lint-roster-quarter: 容許`
 *    這個註解，就當作已經人手審視過並且刻意如此。加這個豁免的時候**一定
 *    要在註解裏寫明理由**——豁免本身不是問題，沒有理由的豁免才是。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

/** 全部「會去讀職事表」的入口。新增入口時一定要同步加進來。 */
const ROSTER_READ_ENTRIES = [
  'listRosterServiceDatesForQuarter_',
  'readRosterSnapshot_',
  'listRosterQuarterAssignedPersons_',
  'listQuarterServiceDates_',
  'resolveQuarterServiceDates_'
];

/** 退回鏈那一支。 */
const FALLBACK_FN = 'resolveWorkingQuarter_';

/** 豁免註解。 */
const ALLOW_MARKER = 'lint-roster-quarter: 容許';

/**
 * 用途：列出 src/ 目錄下全部 .gs 檔案（按檔名字母序）。
 * Args: （無）
 * Returns:
 *   {string[]} 相對於 repo 根目錄的路徑。
 */
function listGasFiles() {
  return fs.readdirSync(SRC_DIR)
    .filter(function (f) { return f.endsWith('.gs'); })
    .sort()
    .map(function (f) { return path.join('src', f); });
}

/**
 * 用途：把一份原始碼切成「一支函式一段」，讓規則 2 只在同一支函式之內比對。
 *
 *   ⚠️ 刻意用最笨的做法（由 `^function ` 切開），不做真正的語法分析：
 *   本專案全部 .gs 的頂層函式都是 `function name_(...) {` 這個寫法，
 *   而 lint 寧可簡單到看得懂，也不要為了通用性引入一個看不懂的剖析器。
 * Args:
 *   lines {string[]} 原始碼逐行。
 * Returns:
 *   {{fnName:string, startLine:number, lines:string[]}[]} `startLine` 由 1 起算。
 *
 *   ⚠️ 欄位刻意叫 `fnName` 而不是 `name`：`tools/scan-staged-secrets.js` 會把
 *   「識別字 ＋ 一點 ＋ name」那種寫法當成網域擋住（`.name` 是真的 gTLD），
 *   見 docs/已知bug類型.md 事故六。這一段連舉例都不可以寫出那個形狀，
 *   否則註解本身就會被擋。
 */
function splitTopLevelFunctions(lines) {
  const blocks = [];
  let current = null;

  lines.forEach(function (line, index) {
    const m = /^function\s+([A-Za-z0-9_$]+)\s*\(/.exec(line);
    if (m) {
      current = { fnName: m[1], startLine: index + 1, lines: [] };
      blocks.push(current);
    }
    if (current) current.lines.push({ text: line, lineNo: index + 1 });
  });

  return blocks;
}

/**
 * 用途：一行（連同它上一行）有沒有豁免註解。
 * Args:
 *   lines {string[]} 全檔逐行。
 *   lineNo {number} 1 起算的行號。
 * Returns:
 *   {boolean}
 */
function hasAllowMarker(lines, lineNo) {
  const here = lines[lineNo - 1] || '';
  const above = lines[lineNo - 2] || '';
  return here.indexOf(ALLOW_MARKER) !== -1 || above.indexOf(ALLOW_MARKER) !== -1;
}

/**
 * 用途：跑兩條規則。
 * Args: （無）
 * Returns:
 *   {{violations:{rule:string, file:string, line:number, message:string}[],
 *     scannedFiles:number, entries:string[]}}
 */
function lint() {
  const violations = [];
  const files = listGasFiles();

  files.forEach(function (relPath) {
    const lines = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8').split(/\r?\n/);

    // ---- 規則 1：直接把退回鏈的結果當參數傳進去 ----
    lines.forEach(function (line, index) {
      const lineNo = index + 1;
      if (hasAllowMarker(lines, lineNo)) return;
      ROSTER_READ_ENTRIES.forEach(function (entry) {
        const idx = line.indexOf(entry + '(');
        if (idx === -1) return;
        const rest = line.slice(idx + entry.length + 1);
        if (rest.indexOf(FALLBACK_FN + '(') === -1) return;
        violations.push({
          rule: '1',
          file: relPath,
          line: lineNo,
          message: entry + '() 直接收 ' + FALLBACK_FN + '() 的結果。'
            + '退回鏈是用來決定「系統預設顯示哪一季」，不是用來決定「去職事表拿哪一季」——'
            + '退回一次就是拿別一季的真實人名回來，而且看起來完全正常。'
            + '請把退回鏈的結果當成選單預設值，由人確認之後再傳下去。'
        });
      });
    });

    // ---- 規則 2：同一支函式之內，退回鏈的結果流進讀職事表的入口 ----
    splitTopLevelFunctions(lines).forEach(function (block) {
      const fallbackVars = [];
      block.lines.forEach(function (row) {
        const m = /var\s+([A-Za-z0-9_$]+)\s*=\s*resolveWorkingQuarter_\s*\(/.exec(row.text);
        if (m) fallbackVars.push(m[1]);
      });
      if (fallbackVars.length === 0) return;

      block.lines.forEach(function (row) {
        if (hasAllowMarker(lines, row.lineNo)) return;
        ROSTER_READ_ENTRIES.forEach(function (entry) {
          const idx = row.text.indexOf(entry + '(');
          if (idx === -1) return;
          const rest = row.text.slice(idx + entry.length + 1);
          fallbackVars.forEach(function (name) {
            const re = new RegExp('\\b' + name + '\\s*\\.\\s*(quarterId|isoDate)\\b');
            if (!re.test(rest)) return;
            violations.push({
              rule: '2',
              file: relPath,
              line: row.lineNo,
              message: '函式 ' + block.fnName + '() 之內，' + FALLBACK_FN
                + '() 的結果（變數 ' + name + '）流進了 ' + entry + '()。'
                + '理由同規則 1。真的要這樣做的話，在那一行加註解「'
                + ALLOW_MARKER + '」並寫明理由。'
            });
          });
        });
      });
    });
  });

  return { violations: violations, scannedFiles: files.length, entries: ROSTER_READ_ENTRIES.slice() };
}

/**
 * 用途：命令列入口。
 * Args: （無）
 * Returns:
 *   {void}
 */
function main() {
  const result = lint();

  if (process.argv.indexOf('--json') !== -1) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.violations.length === 0 ? 0 : 1);
  }

  console.log('掃描 src/*.gs（' + result.scannedFiles + ' 個檔案）：'
    + '「決定哪一季」的退回鏈有沒有流進讀職事表的入口。\n');

  if (result.violations.length === 0) {
    console.log('✓ 沒有發現違規——' + result.entries.join('、')
      + ' 全部都不是收 ' + FALLBACK_FN + '() 的結果。\n');
    process.exit(0);
  }

  console.log('✗ 發現 ' + result.violations.length + ' 項違規：\n');
  result.violations.forEach(function (v) {
    console.log('  [規則 ' + v.rule + '] ' + v.file + ':' + v.line);
    console.log('    ' + v.message + '\n');
  });
  process.exit(1);
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    lint: lint,
    listGasFiles: listGasFiles,
    splitTopLevelFunctions: splitTopLevelFunctions,
    hasAllowMarker: hasAllowMarker,
    ROSTER_READ_ENTRIES: ROSTER_READ_ENTRIES,
    FALLBACK_FN: FALLBACK_FN,
    ALLOW_MARKER: ALLOW_MARKER
  };
}
