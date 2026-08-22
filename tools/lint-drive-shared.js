#!/usr/bin/env node
/**
 * tools/lint-drive-shared.js
 *
 * 靜態檢查：Drive **進階服務**的每一個呼叫都必須帶 `supportsAllDrives`。
 *
 * 執行方式：
 *   node tools/lint-drive-shared.js
 *   node tools/lint-drive-shared.js --json
 *
 * 離開碼：0＝沒有違規　1＝有違規
 *
 * ─────────────────────────────────────────────────────────────────────
 * 為什麼需要這一個工具
 * ─────────────────────────────────────────────────────────────────────
 *
 * 本專案所有檔案都在 **Shared Drive**（共用雲端硬碟）。Drive 進階服務
 * **預設只看「我的雲端硬碟」**——對著一個明明存在的 Shared Drive 檔案，
 * 沒有帶 `supportsAllDrives: true` 就會回
 *
 *     File not found: <fileId>
 *
 * 即 404。這個症狀最要命的地方是它**講了一句假話**：檔案明明在、權限也
 * 對，只是沒有告訴 Drive「請連共用雲端硬碟一起找」。查的人會去確認檔案
 * 存不存在、權限對不對、ID 有沒有貼錯——每一項都會查出「沒問題」。
 *
 * 列檔案／搜檔案的呼叫還要多帶一個 `includeItemsFromAllDrives: true`
 * （前者是「我懂得處理共用雲端硬碟的檔案」，後者是「結果裡請包含共用
 * 雲端硬碟的項目」，兩者缺一不可）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 兩條規則
 * ─────────────────────────────────────────────────────────────────────
 *
 * 1. 任何 `Drive.Files.` 或 `Drive.Drives.` 呼叫，**同一個語句**內必須
 *    出現 `supportsAllDrives`，或者出現共用包裝
 *    `driveSharedOptions_(`／`driveUpdateFileContent_(`。
 *
 *    ⚠️ 為什麼容許包裝：把選項物件寫在每一個呼叫點，等於每一個呼叫點都
 *    有一次寫漏的機會。單一真相來源（`src/DriveShared.gs`）才是正確做法。
 *    但容許包裝會開一個洞——包裝本身如果忘了那個參數，這條規則就形同
 *    虛設。所以有第 2 條。
 *
 * 2. `driveSharedOptions_()` 這個函式本身的內容必須含有
 *    `supportsAllDrives`。第 1 條容許的那個「豁免」，靠這一條堵住。
 *
 * 兩條規則都先用 `tools/lib/maskSource.js` 把字串與註解遮罩掉，避免像
 * 本檔案自己這種「解釋規則」的文件字串被自己掃到而誤判。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { maskStringsAndComments, lineAt } = require('./lib/maskSource');

const JSON_OUTPUT = process.argv.indexOf('--json') !== -1;
const DEFAULT_SRC_DIR = path.join(__dirname, '..', 'src');

/** 受管制的進階服務呼叫前綴。 */
const DRIVE_CALL_PREFIXES = ['Drive.Files.', 'Drive.Drives.'];

/** 必須出現的參數名稱。 */
const REQUIRED_OPTION = 'supportsAllDrives';

/**
 * 容許代替 `supportsAllDrives` 出現的共用包裝。見檔頭規則 1／2。
 * 它們自己一定含有那個參數（由規則 2 保證）。
 */
const ALLOWED_WRAPPERS = ['driveSharedOptions_(', 'driveUpdateFileContent_('];

/** 規則 2 要檢查的那個共用包裝函式。 */
const WRAPPER_FUNCTION_NAME = 'driveSharedOptions_';

/**
 * 用途：由某個位置出發，取出「這一個語句」的文字——往前推到上一個
 *   `;`／`{`／`}`／換行開頭，往後推到配對的結束括號之後那一個 `;`。
 *
 *   ⚠️ 刻意做得寬鬆（多取一點）而不是精準：多取只會令規則更容易通過
 *   （誤放），少取會令正確的寫法被誤判（誤擋）。這個工具寧可漏，不可以
 *   冤枉——被冤枉的人會去改對的程式碼。
 * Args:
 *   masked {string} maskStringsAndComments() 的輸出。
 *   index {number} 呼叫前綴出現的位置。
 * Returns:
 *   {string} 語句文字。
 */
function statementAround(masked, index) {
  let start = index;
  while (start > 0 && ';{}'.indexOf(masked[start - 1]) === -1) start--;

  // 往後推到括號配對完為止，最多再走 4000 個字元（防呆，不可能有更長的語句）。
  let depth = 0;
  let end = index;
  let seenOpen = false;
  const limit = Math.min(masked.length, index + 4000);
  while (end < limit) {
    const ch = masked[end];
    if (ch === '(') { depth++; seenOpen = true; }
    else if (ch === ')') {
      depth--;
      if (seenOpen && depth <= 0) { end++; break; }
    } else if (!seenOpen && ch === ';') {
      break;
    }
    end++;
  }

  return masked.slice(start, Math.min(end + 1, masked.length));
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
 * 用途：對整個 src 目錄執行 Shared Drive 參數檢查。
 * Args:
 *   srcDir {string=} 選填，預設 repo 根目錄下的 src/。
 * Returns:
 *   {{files:string[], violations:{file:string,line:number,rule:string,message:string}[]}}
 */
function lint(srcDir) {
  srcDir = srcDir || DEFAULT_SRC_DIR;
  const files = listGasFiles(srcDir);
  const violations = [];
  let wrapperSeen = false;
  let wrapperOk = false;

  files.forEach(function (fileName) {
    const source = fs.readFileSync(path.join(srcDir, fileName), 'utf8');
    const masked = maskStringsAndComments(source);

    // ---- 規則 1 ----
    DRIVE_CALL_PREFIXES.forEach(function (prefix) {
      let idx = masked.indexOf(prefix);
      while (idx !== -1) {
        const statement = statementAround(masked, idx);
        const hasOption = statement.indexOf(REQUIRED_OPTION) !== -1;
        const hasWrapper = ALLOWED_WRAPPERS.some(function (w) { return statement.indexOf(w) !== -1; });

        if (!hasOption && !hasWrapper) {
          violations.push({
            file: fileName, line: lineAt(masked, idx), rule: 'DRIVE_CALL_WITHOUT_SHARED_DRIVE_SUPPORT',
            message: '「' + prefix + '…」這一個 Drive 進階服務呼叫沒有帶 ' + REQUIRED_OPTION
              + '。本專案所有檔案都在 Shared Drive，缺了它會回一句假的「File not found」'
              + '（檔案明明存在）。請改用 ' + ALLOWED_WRAPPERS.join('／')
              + '（src/DriveShared.gs），不要在呼叫點自己寫選項物件。'
          });
        }
        idx = masked.indexOf(prefix, idx + prefix.length);
      }
    });

    // ---- 規則 2：共用包裝自己一定要有那個參數 ----
    const wrapperIdx = masked.indexOf('function ' + WRAPPER_FUNCTION_NAME);
    if (wrapperIdx !== -1) {
      wrapperSeen = true;
      // 取這個函式往後 1200 個字元就夠——它只是「併一個物件」而已。
      const body = masked.slice(wrapperIdx, wrapperIdx + 1200);
      if (body.indexOf(REQUIRED_OPTION) !== -1) {
        wrapperOk = true;
      } else {
        violations.push({
          file: fileName, line: lineAt(masked, wrapperIdx), rule: 'SHARED_DRIVE_WRAPPER_MISSING_OPTION',
          message: WRAPPER_FUNCTION_NAME + '() 本身沒有 ' + REQUIRED_OPTION
            + '。規則 1 容許呼叫點用這個包裝代替，前提就是它自己一定有；'
            + '它一旦漏掉，全部呼叫點都會靜靜地失去 Shared Drive 支援。'
        });
      }
    }
  });

  // 包裝存在但沒有帶參數，上面已經報過；完全不存在則不報——專案可能
  // 根本沒有用到 Drive 進階服務。
  if (wrapperSeen && !wrapperOk && violations.length === 0) {
    violations.push({
      file: '(src)', line: 0, rule: 'SHARED_DRIVE_WRAPPER_MISSING_OPTION',
      message: WRAPPER_FUNCTION_NAME + '() 找得到，但驗不出它含有 ' + REQUIRED_OPTION + '。'
    });
  }

  return { files: files, violations: violations };
}

function main() {
  const result = lint();

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('掃描 src/*.gs（' + result.files.length + ' 個檔案）的 Shared Drive 參數：\n');
    if (result.violations.length === 0) {
      console.log('✓ 沒有發現違規——每一個 Drive 進階服務呼叫都帶了 ' + REQUIRED_OPTION
        + '（或者經 src/DriveShared.gs 的共用包裝），而那個包裝自己也帶了。');
    } else {
      result.violations.forEach(function (v) {
        console.log('  [' + v.rule + '] ' + v.file + ':' + v.line);
        console.log('      ' + v.message);
      });
      console.log('\n✗ 共 ' + result.violations.length + ' 項違規。');
    }
  }

  process.exit(result.violations.length === 0 ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  lint: lint,
  statementAround: statementAround,
  DRIVE_CALL_PREFIXES: DRIVE_CALL_PREFIXES,
  REQUIRED_OPTION: REQUIRED_OPTION,
  ALLOWED_WRAPPERS: ALLOWED_WRAPPERS,
  WRAPPER_FUNCTION_NAME: WRAPPER_FUNCTION_NAME
};
