'use strict';

/**
 * 用途：把 JavaScript／Apps Script 原始碼內所有「字串常值」（單引號、雙引號、
 *   樣板字串）掃出來，**略過註解與正規表示式常值**。測試用——例如檢查使用者
 *   看得到的字串有沒有帶 Markdown 的 `**`，而註解內的 `**` 是給開發者看的，
 *   不算數。
 *
 *   ⚠️ 這是容錯的簡易掃描器，不是完整語法分析：正規表示式常值靠「前一個有意義
 *   的字元」判斷，足以應付本專案的寫法。樣板字串內的 `${...}` 不另行遞迴，
 *   整段當成一個字串（含 `**` 就會被抓到，寧可多報也不要漏報）。
 * Args:
 *   source {string} 原始碼全文。
 * Returns:
 *   {{text:string, line:number, start:number, end:number}[]} 每個字串常值的內容
 *     （不含引號）、起始行號（從 1 起），以及內容在原始碼內的區間 [start, end)。
 */
function extractStringLiterals(source) {
  const out = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let lastSignificant = '';

  function isRegexStart() {
    return lastSignificant === '' || '(,=:[!&|?{};+-*%<>~^'.indexOf(lastSignificant) !== -1;
  }

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '/' && isRegexStart()) {
      i++;
      let inClass = false;
      while (i < n && source[i] !== '\n') {
        const d = source[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { i++; break; }
        i++;
      }
      lastSignificant = ')';
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      const quote = c;
      const startLine = line;
      let text = '';
      i++;
      const contentStart = i;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') { text += source[i] + (source[i + 1] || ''); i += 2; continue; }
        if (source[i] === '\n') {
          line++;
          if (quote !== '`') break;
        }
        text += source[i];
        i++;
      }
      const contentEnd = i;
      i++;
      out.push({ text: text, line: startLine, start: contentStart, end: contentEnd });
      lastSignificant = quote;
      continue;
    }
    lastSignificant = c;
    i++;
  }
  return out;
}

module.exports = { extractStringLiterals };
