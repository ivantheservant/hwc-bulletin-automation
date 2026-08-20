#!/usr/bin/env node
/**
 * tools/lint-load-order.js
 *
 * 靜態檢查：src/*.gs 的頂層初始化式，是否引用了「宣告在另一個檔案、而
 * 那個檔案按檔名字母序排在本檔案之後」的識別碼。
 *
 * 執行方式：
 *   node tools/lint-load-order.js
 *   node tools/lint-load-order.js --json　（畀程式讀嘅輸出）
 *
 * 離開碼：0＝沒有違規　1＝有違規
 *
 * ─────────────────────────────────────────────────────────────────────
 * 點解要有呢個檢查（事故：onOpen() 完全沒有執行）
 * ─────────────────────────────────────────────────────────────────────
 *
 * Apps Script 會按專案內的檔案次序（按檔名字母序：AuditLog → Bootstrap →
 * ConfigService → Constants → Diagnostics → Menu → SheetUtils）逐個執行
 * 每個 .gs 的**頂層陳述式**。頂層 `var X = <運算式>` 的運算式會在「執行到
 * 這一行」那一刻立即求值；如果運算式引用了另一個檔案宣告的識別碼，而
 * 那個檔案排在後面，讀到的就是 `undefined`（`var` 只是被提升，還未賦值）。
 *
 * 第一輪就是這樣中招：`Bootstrap.gs`（排第 2）的頂層 `var SEED_PROGRAM_TEMPLATES_`
 * 用到 `POSTURE.STAND`，而 `POSTURE` 是 `Constants.gs`（排第 4）才宣告的。
 * 讀 `undefined.STAND` 直接拋 `TypeError`，這個例外發生在**載入階段**，
 * 令整個專案載入失敗，`onOpen()` 這個簡易觸發器根本沒有機會執行——選單
 * 永遠出不到，而且完全沒有錯誤訊息顯示在試算表上，只在 Script Editor 的
 * 執行紀錄看得到。詳見 docs/已知bug類型.md。
 *
 * Node 測試全部通過卻捉不到這個問題，因為舊版 tests/helpers/loadGas.js
 * 是按呼叫方自己指定的次序把檔案載入同一個 vm context（把 Constants.gs
 * 排在最前面），跟 Apps Script 的實際次序不同。這個關卡與
 * tests/helpers/loadGas.js 改用檔名字母序（見該檔案）是互補的兩道防線：
 * 這個關卡在**寫程式碼的當下**用靜態分析攔住，loadGas.js 改用真實次序
 * 讓 tests/*.test.js 在**執行期**也用同一個次序驗證一次。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 這個工具怎麼判斷「頂層」「引用」——以及它的已知限制
 * ─────────────────────────────────────────────────────────────────────
 *
 * 不引入任何 npm 依賴，不是真正的 JS parser，而是：
 *   1. 把字串／樣板字面值與註解的內容換成空白（保留換行與長度），避免
 *      像 seed 資料裡的 '{{ChurchName}}' 被誤判成程式碼的大括號。
 *   2. 切成一串簡化 token（識別碼與少數幾個標點符號）。
 *   3. 用兩個獨立、對稱push/pop 的深度計數器掃過整串 token：
 *      - `funcDepth`：目前是否身處某個 function **主體**（`{...}`）之內。
 *      - `funcParamDepth`：目前是否身處某個 function 的**參數列**
 *        （`(...)`）之內——預設參數值也是呼叫時才求值，同樣要當成延遲。
 *      兩者其中一個 > 0，這個位置的識別碼參照就不算「載入時就會執行」。
 *   4. 頂層宣告：`var`／`const`／`let`／`function` 關鍵字後面緊接的識別碼，
 *      而且當時 funcDepth === funcParamDepth === 0。
 *   5. 頂層參照：不是宣告、不是屬性存取（前面是 `.`）、不是物件字面值的
 *      key（後面是 `:`）、不是保留字，而且當時 funcDepth === funcParamDepth === 0。
 *
 * **已知限制**（刻意的取捨，見下）：
 *   - 只認 `function` 關鍵字寫法（含具名／匿名函式），**不處理 arrow
 *     function 的無大括號單行寫法**（例如 `x => SOME_REF`）——這種寫法
 *     沒有 `{}` 可以標記「主體開始」，需要更完整的 parser 才能正確判斷。
 *     本專案 src/*.gs 目前完全沒有用 arrow function，不影響現有程式碼；
 *     日後如果要用 arrow function，請一律用 `(...) => { ... }`（有大括號）
 *     的寫法，這個工具認得出來。
 *   - 只檢查「引用了在其他檔案宣告、排在後面的識別碼」，**不檢查同一個
 *     檔案內部「引用了在自己檔案內、但宣告在後面」的識別碼**（prompt 明
 *     確把這個工具的範圍界定在跨檔案）。同一個檔案內部的次序仍然要自己
 *     注意：由上而下宣告，不要往後看。
 *   - 如果一個識別碼在全部 src/*.gs 都找不到宣告（例如 SpreadsheetApp、
 *     Utilities、Object 這類 GAS／JS 內建全域），一律略過、不算違規。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const JSON_OUTPUT = process.argv.indexOf('--json') !== -1;
const DEFAULT_SRC_DIR = path.join(__dirname, '..', 'src');

const RESERVED_WORDS = new Set([
  'var', 'const', 'let', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'default', 'break', 'continue', 'true', 'false', 'null',
  'undefined', 'typeof', 'new', 'delete', 'void', 'this', 'in', 'of', 'instanceof',
  'try', 'catch', 'finally', 'throw', 'class', 'extends', 'super', 'yield', 'async',
  'await', 'static', 'get', 'set', 'import', 'export'
]);

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const TOKEN_RE = /[A-Za-z_$][\w$]*|=>|[{}()[\];:,=.]/g;

/**
 * 用途：把原始碼內的字串／樣板字面值與註解內容替換成空白，保留原本的
 *   換行位置與整體長度，避免字串內容（例如 '{{ChurchName}}'）被後續的
 *   token 化步驟誤判成程式碼的大括號或識別碼。
 * Args:
 *   source {string} 原始 .gs 檔案內容。
 * Returns:
 *   {string} 長度與換行位置都跟原文一致，字串／註解內容變成空白的版本。
 */
function maskStringsAndComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const c2 = i + 1 < n ? source[i + 1] : '';

    if (c === '/' && c2 === '/') {
      while (i < n && source[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += (source[i] === '\n') ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      const quote = c;
      out += ' '; i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) {
          out += (source[i + 1] === '\n') ? ' \n' : '  ';
          i += 2;
          continue;
        }
        out += (source[i] === '\n') ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += ' '; i++; }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 用途：把遮罩過的原始碼切成簡化 token 陣列，每個 token 附帶行號。
 * Args:
 *   masked {string} maskStringsAndComments() 的輸出。
 * Returns:
 *   {{text:string, line:number}[]}
 */
function tokenize(masked) {
  const tokens = [];
  let line = 1;
  let cursor = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(masked)) !== null) {
    for (let i = cursor; i < m.index; i++) {
      if (masked[i] === '\n') line++;
    }
    cursor = m.index;
    tokens.push({ text: m[0], line: line });
  }
  return tokens;
}

/**
 * 用途：掃一個檔案的 token 陣列，找出頂層宣告的識別碼，與頂層（載入時就
 *   會執行）位置引用到的識別碼。
 * Args:
 *   tokens {{text:string, line:number}[]} tokenize() 的輸出。
 * Returns:
 *   {{declarations:{name:string,line:number}[], references:{name:string,line:number}[]}}
 */
function scanTokens(tokens) {
  const declarations = [];
  const references = [];

  let generalDepth = 0;
  let funcDepth = 0;
  let funcParamDepth = 0;
  const braceStack = [];
  const parenStack = [];
  let expectFunctionBodyBrace = false;

  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx].text;
    const line = tokens[idx].line;
    const prev = idx > 0 ? tokens[idx - 1].text : '';
    const prev2 = idx > 1 ? tokens[idx - 2].text : '';

    if (t === '(') {
      const isFn = prev === 'function' || (prev2 === 'function' && IDENTIFIER_RE.test(prev));
      parenStack.push(isFn);
      if (isFn) funcParamDepth++;
      generalDepth++;
      continue;
    }
    if (t === ')') {
      const wasFn = parenStack.pop();
      if (wasFn) { funcParamDepth--; expectFunctionBodyBrace = true; }
      generalDepth--;
      continue;
    }
    if (t === '[') { generalDepth++; continue; }
    if (t === ']') { generalDepth--; continue; }
    if (t === '{') {
      const isBody = expectFunctionBodyBrace || prev === '=>';
      expectFunctionBodyBrace = false;
      braceStack.push(isBody);
      if (isBody) funcDepth++;
      generalDepth++;
      continue;
    }
    if (t === '}') {
      const wasBody = braceStack.pop();
      if (wasBody) funcDepth--;
      generalDepth--;
      continue;
    }
    if (t === '=>' || t === '.' || t === ';' || t === ':' || t === ',' || t === '=') {
      if (t !== '=>') expectFunctionBodyBrace = false;
      continue;
    }

    if (!IDENTIFIER_RE.test(t) || RESERVED_WORDS.has(t)) continue;

    const isTopLevelPosition = funcDepth === 0 && funcParamDepth === 0;
    const next = idx + 1 < tokens.length ? tokens[idx + 1].text : '';

    if ((prev === 'var' || prev === 'const' || prev === 'let' || prev === 'function') && isTopLevelPosition) {
      declarations.push({ name: t, line: line });
      continue;
    }

    if (prev === '.') continue;   // 屬性存取，不是變數參照
    if (next === ':') continue;   // 物件字面值的 key，不是變數參照

    if (isTopLevelPosition) {
      references.push({ name: t, line: line });
    }
  }

  return { declarations: declarations, references: references };
}

/**
 * 用途：對整個 src 目錄執行載入次序檢查。
 * Args:
 *   srcDir {string=} 選填，預設 repo 根目錄下的 src/。
 * Returns:
 *   {{files:string[], violations:{file:string,line:number,identifier:string,declaredInFile:string,suggestion:string}[]}}
 */
function lint(srcDir) {
  srcDir = srcDir || DEFAULT_SRC_DIR;
  const files = fs.readdirSync(srcDir)
    .filter(function (f) { return f.endsWith('.gs'); })
    .sort();

  const fileScans = {};
  const declaredIn = {};

  files.forEach(function (fileName) {
    const source = fs.readFileSync(path.join(srcDir, fileName), 'utf8');
    const scan = scanTokens(tokenize(maskStringsAndComments(source)));
    fileScans[fileName] = scan;
    scan.declarations.forEach(function (d) {
      if (!declaredIn[d.name]) declaredIn[d.name] = fileName;
    });
  });

  const violations = [];
  files.forEach(function (fileName, fileIdx) {
    fileScans[fileName].references.forEach(function (ref) {
      const declFile = declaredIn[ref.name];
      if (!declFile) return;
      if (declFile === fileName) return;

      const declFileIdx = files.indexOf(declFile);
      if (declFileIdx > fileIdx) {
        violations.push({
          file: fileName,
          line: ref.line,
          identifier: ref.name,
          declaredInFile: declFile,
          suggestion: '把這個頂層初始化式改成延遲求值的函式，例如 function xxx_() { return [...]; }，'
            + '呼叫端改成呼叫 xxx_()（函式主體只在被呼叫時才執行，那時全部檔案都已經載入完畢）。'
        });
      }
    });
  });

  return { files: files, violations: violations };
}

function main() {
  const result = lint();

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ ok: result.violations.length === 0, files: result.files, violations: result.violations }, null, 2));
    process.exit(result.violations.length === 0 ? 0 : 1);
  }

  console.log('Apps Script 實際載入次序（按檔名字母序）：');
  console.log('  ' + result.files.join(' → ') + '\n');

  if (result.violations.length === 0) {
    console.log('✓ 沒有發現跨檔案的頂層初始化式載入次序問題。');
    process.exit(0);
  }

  console.log('✗ 發現 ' + result.violations.length + ' 項跨檔案載入次序問題——onOpen() 等簡易觸發器可能完全無法執行：\n');
  result.violations.forEach(function (v) {
    console.log('  ' + v.file + ':' + v.line + '　參照了識別碼「' + v.identifier + '」');
    console.log('    這個識別碼宣告在 ' + v.declaredInFile + '，但 Apps Script 會先載入 ' + v.file
      + '（按檔名字母序），屆時 ' + v.declaredInFile + ' 的頂層陳述式還沒執行，讀到的會是 undefined。');
    console.log('    建議：' + v.suggestion + '\n');
  });
  process.exit(1);
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    lint: lint,
    maskStringsAndComments: maskStringsAndComments,
    tokenize: tokenize,
    scanTokens: scanTokens
  };
}
