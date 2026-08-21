#!/usr/bin/env node
/**
 * tests/fixtures/docxXml.js
 *
 * 造 OOXML 片段的小工具，供 tests/docxtemplate.test.js 與
 * tests/docxio.test.js 使用。
 *
 * ⚠️ 第七輪執行時**真正的 .docx 範本還未提供**（Ivan 稍後上傳），
 * 所以測試素材一律是這裡自己造的 XML 字串，不需要真的 .docx 檔案。
 * 這些片段刻意模仿 Word 實際的輸出習慣——尤其是「一個佔位符被拆成
 * 好幾個 <w:r>，中間夾 <w:proofErr>」這種最常見的形態。
 */

'use strict';

/**
 * 用途：造一個 `<w:r>`（文字 run）。
 * Args:
 *   text {string} `<w:t>` 的內容（已經是跳脫過的 XML 文字）。
 *   rPr {string=} `<w:rPr>` 的完整 XML，省略代表沒有格式。
 *   preserve {boolean=} 是否加 `xml:space="preserve"`，預設 false。
 * Returns:
 *   {string}
 */
function run(text, rPr, preserve) {
  var attr = preserve ? ' xml:space="preserve"' : '';
  return '<w:r>' + (rPr || '') + '<w:t' + attr + '>' + text + '</w:t></w:r>';
}

/**
 * 用途：造一個 `<w:p>`（段落）。
 * Args:
 *   inner {string} 段落內容（通常是一串 run）。
 *   pPr {string=} `<w:pPr>` 的完整 XML。
 * Returns:
 *   {string}
 */
function para(inner, pPr) {
  return '<w:p>' + (pPr || '') + inner + '</w:p>';
}

/**
 * 用途：造一個 `<w:tc>`（表格儲存格）。
 * Args:
 *   inner {string} 儲存格內容（通常是一或多個段落）。
 * Returns:
 *   {string}
 */
function cell(inner) {
  return '<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>' + inner + '</w:tc>';
}

/**
 * 用途：造一個 `<w:tr>`（表格列）。
 * Args:
 *   cells {string[]} 每個元素是 `cell()` 的輸出。
 * Returns:
 *   {string}
 */
function row(cells) {
  return '<w:tr>' + cells.join('') + '</w:tr>';
}

/**
 * 用途：造一個 `<w:tbl>`（表格）。
 * Args:
 *   rows {string[]} 每個元素是 `row()` 的輸出。
 * Returns:
 *   {string}
 */
function table(rows) {
  return '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' + rows.join('') + '</w:tbl>';
}

/**
 * 用途：把內容包成一份完整的 `word/document.xml`。
 * Args:
 *   inner {string} `<w:body>` 的內容。
 * Returns:
 *   {string}
 */
function documentXml(inner) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:body>' + inner
    + '<w:sectPr><w:pgSz w:w="8391" w:h="11907"/></w:sectPr>'
    + '</w:body></w:document>';
}

/**
 * 用途：造一個「被 Word 拆散」的佔位符段落——把一個佔位符切成好幾個
 *   run，中間夾拼寫檢查標記，模仿 Word 實際的輸出。
 * Args:
 *   pieces {string[]} 佔位符被切開的每一片，例如
 *     `['{{', 'SERMON', '_TITLE}}']`。
 *   rPr {string=} 每個 run 共用的格式（相同才會被合併）。
 * Returns:
 *   {string} 一個 `<w:p>`。
 */
function splitPlaceholderParagraph(pieces, rPr) {
  var inner = pieces.map(function (piece, i) {
    var proof = i === 0 ? '' : '<w:proofErr w:type="spellStart"/>';
    return proof + run(piece, rPr);
  }).join('');
  return para(inner);
}

/**
 * 用途：造一個程序表——一般列範本 ＋ 全寬列範本，交錯展開用。
 * Args: （無）
 * Returns:
 *   {string} 一個 `<w:tbl>`。
 */
function programTable() {
  return table([
    row([cell(para(run('{{#EACH:PROGRAM}}{{PROGRAM.ITEM}}'))),
      cell(para(run('{{PROGRAM.CONTENT}}'))),
      cell(para(run('{{PROGRAM.POSTURE}}')))]),
    row([cell(para(run('{{#EACH:PROGRAM_FW}}{{PROGRAM.CONTENT}}')))])
  ]);
}

module.exports = {
  run: run,
  para: para,
  cell: cell,
  row: row,
  table: table,
  documentXml: documentXml,
  splitPlaceholderParagraph: splitPlaceholderParagraph,
  programTable: programTable
};
