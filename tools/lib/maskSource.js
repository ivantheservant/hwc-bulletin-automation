'use strict';
/**
 * tools/lib/maskSource.js
 *
 * 共用工具：把原始碼內的字串／樣板字面值與註解內容替換成空白，保留原本
 * 的換行位置與整體長度。tools/lint-load-order.js 與
 * tools/lint-readonly-roster.js 都用得到——兩者都需要在做正則／子字串
 * 比對之前，先排除字串與註解內容誤判成程式碼的風險（例如 seed 資料裡的
 * '{{ChurchName}}'，或註解裡剛好提到 `setValue` 這個方法名稱）。
 */

/**
 * 用途：把原始碼內的字串／樣板字面值與註解內容替換成空白。
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
 * 用途：計算某個字串位移對應原始碼的第幾行（1-based）。
 * Args:
 *   str {string} 原始碼（或遮罩過的版本，長度／換行位置要跟原文一致）。
 *   index {number} 字元位移。
 * Returns:
 *   {number}
 */
function lineAt(str, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (str[i] === '\n') line++;
  }
  return line;
}

module.exports = { maskStringsAndComments: maskStringsAndComments, lineAt: lineAt };
