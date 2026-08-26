#!/usr/bin/env node
/**
 * tools/lint-service-dates.js
 *
 * 靜態檢查：**「這一季有哪幾個主日」只准有一個入口。**
 *
 * 執行方式：
 *   node tools/lint-service-dates.js
 *   node tools/lint-service-dates.js --json
 *
 * 離開碼：0＝沒有違規　1＝有違規
 *
 * ─────────────────────────────────────────────────────────────────────
 * 為什麼要有這一條（docs/待確認事項.md V-2）
 * ─────────────────────────────────────────────────────────────────────
 *
 * `listQuarterServiceDates_()` **只讀職事表**。R-036 之後，職事表未有該季
 * 資料一樣建立得到週報，但全專案有九個地方各自呼叫它去問「這一季有哪幾個
 * 主日」，於是那些季度全部得到一張空清單：匯入回「新增 0、修改 0、刪除 0、
 * 不變 0」、產生全季週報一份都不產生、團契一個都不產生、季度填寫表建立
 * 不到、演練跑不動、待填清單是空的。
 *
 * **全部都不是報錯，是靜靜地什麼都不做**——比報錯難發現得多。
 *
 * 正確入口是 `resolveQuarterServiceDateEntries_()`（`src/ServiceDates.gs`）：
 * 職事表 → **同一季的** `BulletinWeeks` → 曆法推算 → `NONE`，而且講得出
 * 自己用了哪一個來源。
 *
 * ⚠️ 退回的只是「用哪一份清單」，四個來源全部只看同一個季度，一個都不會
 * 跨季——那是事故四十一那一條紀律。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 掃描一條規則
 * ─────────────────────────────────────────────────────────────────────
 *
 * `src/` 內不准直接呼叫 `listQuarterServiceDates_(`，除了：
 *
 *   - `src/FillGrid.gs`——它是那一支的**定義處**；
 *   - `src/ServiceDates.gs`——它是那個唯一的包裝，包的正是它。
 *
 * ⚠️ 註解與 docstring 不算（只掃真正的呼叫，也就是後面緊接著 `(` 而且
 * 那一行不是以 `*` 或 `//` 開頭的）。
 *
 * ⚠️ 例外：那一行（或上一行）有 `lint-service-dates: 容許` 這個註解，就當作
 * 已經人手審視過並且刻意如此。加這個豁免的時候**一定要在註解裏寫明理由**
 * ——豁免本身不是問題，沒有理由的豁免才是。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

/** 只准經這一支拿主日清單。 */
const SHARED_ENTRY = 'resolveQuarterServiceDateEntries_';

/** 被包起來、不准再直接呼叫的那一支。 */
const RAW_ENTRY = 'listQuarterServiceDates_';

/** 准許直接呼叫的檔案：定義處與唯一的包裝。 */
const ALLOWED_FILES = [
  path.join('src', 'FillGrid.gs'),
  path.join('src', 'ServiceDates.gs')
];

/** 豁免註解。 */
const ALLOW_MARKER = 'lint-service-dates: 容許';

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
 * 用途：一行是不是純註解（docstring 或者 `//`）。
 *
 *   ⚠️ 註解裏提起那一支函式是完全正常的（本檔案自己就提了很多次），
 *   把註解也當成違規，等於逼人不可以解釋自己在做什麼。
 * Args:
 *   line {string} 一行原始碼。
 * Returns:
 *   {boolean}
 */
function isCommentLine(line) {
  const trimmed = String(line || '').trim();
  return trimmed.indexOf('*') === 0 || trimmed.indexOf('//') === 0 || trimmed.indexOf('/*') === 0;
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
 * 用途：跑那一條規則。
 * Args: （無）
 * Returns:
 *   {{violations:{file:string, line:number, message:string}[],
 *     scannedFiles:number, callers:string[]}}
 *     `callers` 是有經共用入口拿主日清單的檔案清單，供報告顯示。
 */
function lint() {
  const violations = [];
  const callers = [];
  const files = listGasFiles();

  files.forEach(function (relPath) {
    const lines = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8').split(/\r?\n/);
    let usesShared = false;

    lines.forEach(function (line, index) {
      const lineNo = index + 1;
      if (line.indexOf(SHARED_ENTRY + '(') !== -1 && !isCommentLine(line)) usesShared = true;

      if (ALLOWED_FILES.indexOf(relPath) !== -1) return;
      if (isCommentLine(line)) return;
      if (line.indexOf(RAW_ENTRY + '(') === -1) return;
      if (hasAllowMarker(lines, lineNo)) return;

      violations.push({
        file: relPath,
        line: lineNo,
        message: '直接呼叫了 ' + RAW_ENTRY + '()。那一支**只讀職事表**，'
          + '職事表未有該季時會回一張空清單，而呼叫方多數會把空清單當成'
          + '「這一季沒有主日」靜靜地什麼都不做——不是報錯，比報錯難發現得多。'
          + '請改用 ' + SHARED_ENTRY + '()（src/ServiceDates.gs），'
          + '它會退回 BulletinWeeks／曆法推算，而且講得出自己用了哪一個來源。'
          + '真的要直接叫的話，在那一行加註解「' + ALLOW_MARKER + '」並寫明理由。'
      });
    });

    if (usesShared && ALLOWED_FILES.indexOf(relPath) === -1) callers.push(relPath);
  });

  return { violations: violations, scannedFiles: files.length, callers: callers };
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
    + '「這一季有哪幾個主日」有沒有繞過共用入口。\n');

  if (result.violations.length === 0) {
    console.log('✓ 沒有發現違規——' + result.callers.length + ' 個檔案經 '
      + SHARED_ENTRY + '() 拿主日清單：');
    result.callers.forEach(function (f) { console.log('    ' + f); });
    console.log('');
    process.exit(0);
  }

  console.log('✗ 發現 ' + result.violations.length + ' 項違規：\n');
  result.violations.forEach(function (v) {
    console.log('  ' + v.file + ':' + v.line);
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
    isCommentLine: isCommentLine,
    hasAllowMarker: hasAllowMarker,
    SHARED_ENTRY: SHARED_ENTRY,
    RAW_ENTRY: RAW_ENTRY,
    ALLOWED_FILES: ALLOWED_FILES,
    ALLOW_MARKER: ALLOW_MARKER
  };
}
