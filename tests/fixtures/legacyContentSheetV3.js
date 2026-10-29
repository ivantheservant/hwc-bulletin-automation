#!/usr/bin/env node
/**
 * tests/fixtures/legacyContentSheetV3.js
 *
 * 內容表 **v3**（2026-10-26 至 2026-10-30 示範）的分頁定義，**寫死凍結**。
 *
 * ⚠️ 為甚麼要寫死：v4（2026-10-30）改了「崇拜程序」（只留三欄，拿走「有效」）、「家事報告」「代禱事項」的欄位
 *    次序（連續到、有效搬到 B、C 欄），「財政報告」最後加「附註」「銀行結餘」。v3 → v4 測試要造一份「真的是 v3」
 *    的內容表；由 src 衍生的話，src 一改測試就靜靜地測一件不存在的事（bug class 39）。
 *
 *    內容抄自 commit 6af2786 的 `src/ContentSheet.gs`（第 1、2 行）。「團契聚會」「崇拜人數」v3 與 v4 欄位相同，
 *    由 src 造。**這個檔案以後不可以再改**。
 */

'use strict';

const LEGACY_V3_TAB_DEFS = Object.freeze({
  崇拜程序: Object.freeze({
    tabName: '崇拜程序',
    headers: ['主日日期', '讀經經文', '證道講題', '回應詩歌', '詩班曲名', '有效', '備註',
      '序樂', '宣召出處', '宣召經文', '詩歌頌讚', '詩班項目名稱'],
    keys: ['SERVICE_DATE', 'SCRIPTURE_REF', 'SERMON_TITLE', 'RESPONSE_HYMN', 'CHOIR_TITLE', 'ACTIVE', 'NOTES',
      'PRELUDE', 'CALL_REF', 'CALL_TEXT', 'HYMN_PRAISE', 'CHOIR_LABEL']
  }),
  家事報告: Object.freeze({
    tabName: '家事報告',
    headers: ['主日日期', '次序', '內容', '連續到', '有效', '來源', '原文備份'],
    keys: ['SERVICE_DATE', 'SEQ_NO', 'TEXT', 'REPEAT_UNTIL', 'ACTIVE', 'SOURCE', 'SOURCE_SNAPSHOT']
  }),
  代禱事項: Object.freeze({
    tabName: '代禱事項',
    headers: ['主日日期', '次序', '內容', '連續到', '有效'],
    keys: ['SERVICE_DATE', 'SEQ_NO', 'TEXT', 'REPEAT_UNTIL', 'ACTIVE']
  }),
  財政報告: Object.freeze({
    tabName: '財政報告',
    headers: ['主日日期', '次序', '報告標題', '項目', '欄一', '欄二', '欄三', '欄四', '有效'],
    keys: ['SERVICE_DATE', 'SEQ_NO', 'TITLE_OVERRIDE', 'ROW_LABEL', 'COL1', 'COL2', 'COL3', 'COL4', 'ACTIVE']
  })
});

/**
 * 用途：v3 內容表的分頁定義：src 現時的分頁，把「崇拜程序」「家事報告」「代禱事項」「財政報告」換成凍結的 v3 定義。
 * Args:
 *   currentDefs {Object[]} src 的 `contentSheetTabDefs_()`。
 * Returns:
 *   {Object[]} 新陣列（次序同 src）。
 */
function legacyContentTabDefsV3(currentDefs) {
  return (currentDefs || []).map(function (d) {
    return LEGACY_V3_TAB_DEFS[d.tabName] ? JSON.parse(JSON.stringify(LEGACY_V3_TAB_DEFS[d.tabName])) : d;
  });
}

module.exports = { LEGACY_V3_TAB_DEFS, legacyContentTabDefsV3 };
