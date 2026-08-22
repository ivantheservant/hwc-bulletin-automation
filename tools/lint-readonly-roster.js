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
 * 1. `openById(` 只准出現在 src/RosterRead.gs 與 src/ContentSheetIo.gs。
 *    任何一個週報自己的 Google 試算表操作都是透過
 *    SpreadsheetApp.getActiveSpreadsheet()；需要另外開啟「別的試算表」的
 *    地方只有兩個——讀職事表（RosterRead.gs），與讀寫每季的「內容表」
 *    （ContentSheetIo.gs，R-010／R-013）。把 openById 這個能力鎖死在
 *    **少數幾個指定檔案**，才有辦法逐一稽核，也讓日後任何人一眼就看得出
 *    「跨試算表存取只集中在這幾個地方」。
 *
 *    ⚠️ ContentSheetIo.gs 是內容表那一輪新加入的。它會**寫入**內容表
 *    （那是它的職責），所以第 2 條那種「不准有寫入方法」的稽核對它不適用；
 *    改為用第 4 條那一招把它跟職事表隔開——它拿不到職事表 ID，就沒有辦法
 *    自己找到職事表。
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
 * 3. `DriveApp` 與 Drive **進階服務**（`Drive.Files`）只准出現在
 *    src/DocxIo.gs、src/ContentSheetIo.gs、src/PublishIo.gs。
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
 * 4. 凡是獲准使用 `DriveApp` 或 `openById(` 的檔案（RosterRead.gs 除外），
 *    一律不准出現 `ROSTER_SPREADSHEET_ID`。目前是 src/DocxIo.gs 與
 *    src/ContentSheetIo.gs。
 *
 *    這是規則 1／3 放寬之後補上的防線：`DriveApp.getFileById()` 與
 *    `SpreadsheetApp.openById()` 理論上都可以開啟**任何**檔案，包括職事表
 *    本身。靜態上無法證明某個執行期變數不是職事表 ID，但可以證明**這個
 *    檔案拿不到職事表 ID 這個設定鍵**——只要它從來沒有引用過那個 Config
 *    鍵，它就沒有辦法自己找到職事表。真正需要職事表 ID 的只有
 *    RosterRead.gs，而那個檔案不准有任何寫入方法（規則 2）。
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

/** 每季「內容表」的 Drive／跨試算表 IO，全部鎖死在這一個檔案。 */
const CONTENT_SHEET_IO_FILE = 'ContentSheetIo.gs';

/** 發佈（master PDF 覆寫、存檔副本）的 Drive IO，全部鎖死在這一個檔案。 */
const PUBLISH_IO_FILE = 'PublishIo.gs';

/**
 * 准許使用 `DriveApp`／`Drive.Files`（進階服務）的檔案。見檔頭規則 3／4
 * 的說明：能力鎖死在少數幾個指定檔案，而且那幾個檔案一律拿不到職事表 ID。
 */
const DRIVE_APP_FILES = ['DocxIo.gs', CONTENT_SHEET_IO_FILE, PUBLISH_IO_FILE];

/**
 * Drive **進階服務**的呼叫形式。`DriveApp` 與它是兩個不同的識別碼，但
 * 兩者都可以開啟任何檔案，所以受同一條規則管。
 *
 * ⚠️ 刻意比對 `Drive.Files` 而不是單一個 `Drive`：後者會連
 * `probeDriveAccess_()` 這類本來就刻意避開 `DriveApp` 的名稱一併誤判
 * （見本檔案「本專案要反覆自問的 bug class」第 25 條的同一類問題）。
 */
const DRIVE_ADVANCED_TOKEN = 'Drive.Files';

/** 准許使用 `openById(` 的檔案。見檔頭規則 1。 */
const OPEN_BY_ID_FILES = [ROSTER_READ_FILE, CONTENT_SHEET_IO_FILE];

/**
 * 拿得到 `DriveApp`／`openById(` 的檔案內，一律不准出現這個識別碼——
 * 拿不到職事表 ID，就沒有辦法開啟職事表。`RosterRead.gs` 是唯一例外
 * （它本來就要讀職事表），改為由規則 2 保證它一個格都寫不到。
 */
const ROSTER_ID_CONFIG_KEY = 'ROSTER_SPREADSHEET_ID';

/** 要套用規則 4 的檔案：獲准的高權限檔案，扣除 RosterRead.gs。 */
const ROSTER_ID_FORBIDDEN_FILES = DRIVE_APP_FILES.concat(OPEN_BY_ID_FILES)
  .filter(function (f, i, arr) { return f !== ROSTER_READ_FILE && arr.indexOf(f) === i; });

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

    // 規則 1：openById( 只准出現在指定檔案。
    if (OPEN_BY_ID_FILES.indexOf(fileName) === -1) {
      findOccurrenceLines(masked, 'openById(').forEach(function (line) {
        violations.push({
          file: fileName, line: line, rule: 'OPEN_BY_ID_OUTSIDE_ALLOWED_FILES',
          message: '「openById(」只准出現在 ' + OPEN_BY_ID_FILES.join('、') + '。硬規則：對職事表試算表一律唯讀，'
            + '跨試算表的存取一律集中在少數幾個指定檔案，才有辦法逐一稽核。'
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

    // 規則 3：DriveApp 與 Drive 進階服務只准出現在指定檔案。
    if (DRIVE_APP_FILES.indexOf(fileName) === -1) {
      ['DriveApp', DRIVE_ADVANCED_TOKEN].forEach(function (token) {
        findOccurrenceLines(masked, token).forEach(function (line) {
          violations.push({
            file: fileName, line: line, rule: 'DRIVE_APP_OUTSIDE_ALLOWED_FILES',
            message: '「' + token + '」只准出現在 ' + DRIVE_APP_FILES.join('、') + '（有繞過職事表唯讀邊界的風險）。'
              + 'Word 範本讀寫 Drive、內容表建立檔案、發佈覆寫 master PDF 是僅有的例外，'
              + '而且各自集中在單一檔案，這樣「有沒有人用 Drive 繞過唯讀邊界」永遠只需要審那幾個檔案。'
          });
        });
      });
    }

    // 規則 4：高權限檔案（RosterRead.gs 除外）一律拿不到職事表 ID。
    if (ROSTER_ID_FORBIDDEN_FILES.indexOf(fileName) !== -1) {
      findOccurrenceLines(masked, ROSTER_ID_CONFIG_KEY).forEach(function (line) {
        violations.push({
          file: fileName, line: line, rule: 'ROSTER_ID_IN_PRIVILEGED_FILE',
          message: '「' + ROSTER_ID_CONFIG_KEY + '」不可以出現在 ' + fileName + '。'
            + '這個檔案獲准使用 DriveApp／openById()，而兩者都可以開啟任何檔案；'
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
    console.log('✓ 沒有發現違規——openById 只在 ' + OPEN_BY_ID_FILES.join('、') + '、'
      + ROSTER_READ_FILE + ' 沒有任何寫入方法、'
      + 'DriveApp 只在 ' + DRIVE_APP_FILES.join('、') + '、'
      + '而 ' + ROSTER_ID_FORBIDDEN_FILES.join('、') + ' 拿不到職事表 ID。');
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
    DRIVE_APP_FILES: DRIVE_APP_FILES,
    OPEN_BY_ID_FILES: OPEN_BY_ID_FILES,
    ROSTER_ID_FORBIDDEN_FILES: ROSTER_ID_FORBIDDEN_FILES,
    CONTENT_SHEET_IO_FILE: CONTENT_SHEET_IO_FILE,
    PUBLISH_IO_FILE: PUBLISH_IO_FILE,
    DRIVE_ADVANCED_TOKEN: DRIVE_ADVANCED_TOKEN,
    ROSTER_READ_FILE: ROSTER_READ_FILE
  };
}
