#!/usr/bin/env node
/**
 * tools/lint-readonly-roster.js
 *
 * 靜態檢查：確保本專案對「粵語堂職事表」試算表一律唯讀——這是本專案的
 * 硬規則之一（見 prompt2.md／docs/職事表唯讀介面.md）：一個格都不可以寫，
 * 有落差就在週報這邊處理，不會要求職事表系統改動任何一行程式碼。
 *
 * 執行方式：
 *   node tools/lint-readonly-roster.js
 *   node tools/lint-readonly-roster.js --json
 *
 * 離開碼：0＝沒有違規　1＝有違規
 *
 * ─────────────────────────────────────────────────────────────────────
 * 掃描三條規則
 * ─────────────────────────────────────────────────────────────────────
 *
 * 1. `openById(` 只准出現在 src/RosterRead.gs。任何一個週報自己的
 *    Google 試算表操作都是透過 SpreadsheetApp.getActiveSpreadsheet()，
 *    唯一需要另外開啟「別的試算表」的地方就是讀職事表；把 openById 這個
 *    能力鎖死在單一檔案，才有辦法用第 2 條規則稽核「這個檔案有沒有偷偷
 *    寫入」，也讓日後任何人一眼就看得出「跨試算表讀取只集中在這裡」。
 *
 * 2. src/RosterRead.gs 內不准出現任何寫入類方法（見 FORBIDDEN_WRITE_METHODS）。
 *    這一條是唯讀承諾真正的防線：就算 1 沒破，只要這個檔案本身不含任何
 *    寫入方法，物理上就不可能寫壞職事表。方法清單刻意抓寬（連
 *    `setBackground` 這類「看似無害」的格式化方法都算），因為唯讀就是
 *    唯讀，沒有「無害的寫入」這回事。
 *
 *    ⚠️ `sort(` 是唯一需要額外判斷的一個：`Range.prototype.sort()`（Sheets
 *    的列排序，真的是寫入）跟 JS 原生 `Array.prototype.sort()`（單純排一個
 *    記憶體內的陣列，跟試算表無關）剛好同名。純函式層排序 posts／日期這類
 *    陣列是完全安全、而且必要的操作，不應該被禁止。兩者的關鍵分別：
 *    `Range.sort()` 的參數是數字或欄位排序規格（例如 `range.sort(1)`），
 *    `Array.sort()` 的參數是一個比較函式（例如 `arr.sort(function(a,b){...})`）。
 *    所以這個工具只在 `sort(` 後面**不是**緊接著 `function` 關鍵字或箭頭
 *    函式時才算違規——真正呼叫 Range.sort() 幾乎不可能長成比較函式的樣子。
 *
 * 3. `DriveApp` 只准出現在 src/DocxIo.gs。
 *
 *    ⚠️ 這一條在第七輪之前是「全 src/ 一律不准」。當時的註解寫明「日後
 *    真的需要才另外設計審查」——第七輪就是那個時候：Word（`.docx`）範本
 *    渲染一定要由 Drive 讀範本檔、把成品寫回輸出資料夾，沒有 `DriveApp`
 *    根本做不到。
 *
 *    設計上跟規則 1 完全同一個手法：把能力鎖死在**單一檔案**，其餘檔案
 *    照舊一律不准，這樣「有沒有人用 Drive 繞過唯讀邊界」永遠只需要審
 *    一個檔案。配合規則 4，那個檔案物理上拿不到職事表的 ID。
 *
 * 4. src/DocxIo.gs 內不准出現 `ROSTER_SPREADSHEET_ID`，也不准出現
 *    `openById(`（後者已由規則 1 涵蓋）。
 *
 *    這是規則 3 放寬之後補上的防線：`DriveApp.getFileById()` 理論上可以
 *    開啟**任何**檔案，包括職事表本身。靜態上無法證明某個執行期變數不是
 *    職事表 ID，但可以證明**這個檔案拿不到職事表 ID 這個設定鍵**——只要
 *    它從來沒有引用過那個 Config 鍵，它就沒有辦法自己找到職事表。
 *    真正需要職事表 ID 的只有 RosterRead.gs，而那個檔案不准有寫入方法。
 *
 * 四條規則都會先用 tools/lib/maskSource.js 把字串與註解內容遮罩掉，
 * 避免像本檔案自己這種「解釋規則」的文件字串／註解，被自己掃到而誤判。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { maskStringsAndComments, lineAt } = require('./lib/maskSource');

const JSON_OUTPUT = process.argv.indexOf('--json') !== -1;
const DEFAULT_SRC_DIR = path.join(__dirname, '..', 'src');
const ROSTER_READ_FILE = 'RosterRead.gs';

/**
 * 唯一准許使用 `DriveApp` 的檔案（第七輪起）。見檔頭規則 3／4 的說明：
 * 能力鎖死在單一檔案，而且那個檔案拿不到職事表 ID。
 */
const DRIVE_APP_FILE = 'DocxIo.gs';

/**
 * `DRIVE_APP_FILE` 內不准出現的識別碼——拿不到職事表 ID，就沒有辦法用
 * `DriveApp.getFileById()` 開啟職事表。
 */
const ROSTER_ID_CONFIG_KEY = 'ROSTER_SPREADSHEET_ID';

const FORBIDDEN_WRITE_METHODS = [
  'setValue', 'setValues', 'setFormula', 'setFormulas', 'appendRow', 'insertRows',
  'insertRowAfter', 'insertRowBefore', 'deleteRow', 'deleteRows', 'deleteColumn',
  'deleteColumns', 'insertSheet', 'deleteSheet', 'clearContents', 'clear(',
  'setName', 'copyTo', 'moveTo', 'setBackground', 'setFontWeight', 'setNumberFormat',
  'sort(', 'setFrozenRows', 'addDeveloperMetadata', 'getUi('
];

/**
 * 用途：在遮罩過的原始碼裡找出某個子字串全部出現的行號。
 * Args:
 *   masked {string} maskStringsAndComments() 的輸出。
 *   needle {string} 要找的子字串。
 * Returns:
 *   {number[]}
 */
function findOccurrenceLines(masked, needle) {
  const lines = [];
  let idx = masked.indexOf(needle);
  while (idx !== -1) {
    lines.push(lineAt(masked, idx));
    idx = masked.indexOf(needle, idx + needle.length);
  }
  return lines;
}

/**
 * 用途：找出 `sort(` 出現的行號，但排除「參數是比較函式」的呼叫——那是
 *   JS 原生 Array.prototype.sort()，不是 Sheets 的 Range.prototype.sort()。
 *   判斷方式見本檔案檔頭「掃描三條規則」第 2 條的說明。
 * Args:
 *   masked {string} maskStringsAndComments() 的輸出。
 * Returns:
 *   {number[]}
 */
function findSuspiciousSortCalls(masked) {
  const lines = [];
  let idx = masked.indexOf('sort(');
  while (idx !== -1) {
    const after = masked.slice(idx + 'sort('.length, idx + 'sort('.length + 40).replace(/^\s+/, '');
    const looksLikeComparator = /^function\b/.test(after) || /^\([^()]*\)\s*=>/.test(after) || /^[A-Za-z_$][\w$]*\s*=>/.test(after);
    if (!looksLikeComparator) {
      lines.push(lineAt(masked, idx));
    }
    idx = masked.indexOf('sort(', idx + 'sort('.length);
  }
  return lines;
}

/**
 * 用途：讀取 srcDir 底下全部 .gs 檔名（不含路徑），按檔名排序。
 * Args:
 *   srcDir {string}
 * Returns:
 *   {string[]}
 */
function listGasFiles(srcDir) {
  return fs.readdirSync(srcDir).filter(function (f) { return f.endsWith('.gs'); }).sort();
}

/**
 * 用途：對整個 src 目錄執行職事表唯讀邊界檢查。
 * Args:
 *   srcDir {string=} 選填，預設 repo 根目錄下的 src/。
 * Returns:
 *   {{files:string[], violations:{file:string,line:number,rule:string,message:string}[]}}
 */
function lint(srcDir) {
  srcDir = srcDir || DEFAULT_SRC_DIR;
  const files = listGasFiles(srcDir);
  const violations = [];

  files.forEach(function (fileName) {
    const source = fs.readFileSync(path.join(srcDir, fileName), 'utf8');
    const masked = maskStringsAndComments(source);

    // 規則 1：openById( 只准出現在 RosterRead.gs。
    if (fileName !== ROSTER_READ_FILE) {
      findOccurrenceLines(masked, 'openById(').forEach(function (line) {
        violations.push({
          file: fileName, line: line, rule: 'OPEN_BY_ID_OUTSIDE_ROSTER_READ',
          message: '「openById(」只准出現在 ' + ROSTER_READ_FILE + '。硬規則：對職事表試算表一律唯讀，'
            + '跨試算表的讀取一律集中在單一檔案，才有辦法稽核「這個檔案有沒有偷偷寫入」。'
        });
      });
    }

    // 規則 2：RosterRead.gs 內不准出現寫入類方法。
    if (fileName === ROSTER_READ_FILE) {
      FORBIDDEN_WRITE_METHODS.forEach(function (method) {
        // sort( 要排除「參數是比較函式」的 Array.prototype.sort() 呼叫，
        // 其餘方法名稱在 Apps Script 以外沒有歧義，直接找字串就好。
        var occurrenceLines = (method === 'sort(') ? findSuspiciousSortCalls(masked) : findOccurrenceLines(masked, method);
        occurrenceLines.forEach(function (line) {
          violations.push({
            file: fileName, line: line, rule: 'WRITE_METHOD_IN_ROSTER_READ',
            message: '「' + method + '」是寫入類方法，不可以出現在 ' + ROSTER_READ_FILE
              + '。硬規則：對職事表試算表一律唯讀，一個格都不可以寫。'
          });
        });
      });
    }

    // 規則 3：DriveApp 只准出現在 DocxIo.gs。
    if (fileName !== DRIVE_APP_FILE) {
      findOccurrenceLines(masked, 'DriveApp').forEach(function (line) {
        violations.push({
          file: fileName, line: line, rule: 'DRIVE_APP_OUTSIDE_DOCX_IO',
          message: '「DriveApp」只准出現在 ' + DRIVE_APP_FILE + '（有繞過職事表唯讀邊界的風險）。'
            + 'Word 範本要讀寫 Drive 是唯一的例外，而且一律集中在那個檔案，'
            + '這樣「有沒有人用 Drive 繞過唯讀邊界」永遠只需要審一個檔案。'
        });
      });
    }

    // 規則 4：DocxIo.gs 拿不到職事表 ID（規則 3 放寬之後補上的防線）。
    if (fileName === DRIVE_APP_FILE) {
      findOccurrenceLines(masked, ROSTER_ID_CONFIG_KEY).forEach(function (line) {
        violations.push({
          file: fileName, line: line, rule: 'ROSTER_ID_IN_DRIVE_APP_FILE',
          message: '「' + ROSTER_ID_CONFIG_KEY + '」不可以出現在 ' + DRIVE_APP_FILE + '。'
            + '這個檔案是全 src/ 唯一可以用 DriveApp 的地方，而 DriveApp.getFileById() 可以開啟任何檔案；'
            + '只要它從來拿不到職事表 ID，它就沒有辦法自己找到職事表。'
        });
      });
    }
  });

  return { files: files, violations: violations };
}

function main() {
  const result = lint();

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ ok: result.violations.length === 0, files: result.files, violations: result.violations }, null, 2));
    process.exit(result.violations.length === 0 ? 0 : 1);
  }

  console.log('掃描 src/*.gs（' + result.files.length + ' 個檔案）的職事表唯讀邊界：\n');

  if (result.violations.length === 0) {
    console.log('✓ 沒有發現違規——openById 只在 ' + ROSTER_READ_FILE + '、該檔案沒有任何寫入方法、'
      + 'DriveApp 只在 ' + DRIVE_APP_FILE + '、而那個檔案拿不到職事表 ID。');
    process.exit(0);
  }

  console.log('✗ 發現 ' + result.violations.length + ' 項違規：\n');
  result.violations.forEach(function (v) {
    console.log('  [' + v.rule + '] ' + v.file + ':' + v.line);
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
    FORBIDDEN_WRITE_METHODS: FORBIDDEN_WRITE_METHODS,
    findSuspiciousSortCalls: findSuspiciousSortCalls,
    DRIVE_APP_FILE: DRIVE_APP_FILE,
    ROSTER_READ_FILE: ROSTER_READ_FILE
  };
}
