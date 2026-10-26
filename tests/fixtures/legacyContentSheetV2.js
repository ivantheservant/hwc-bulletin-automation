#!/usr/bin/env node
/**
 * tests/fixtures/legacyContentSheetV2.js
 *
 * 內容表 **v2**（2026-10-23 部署、2026-10-26 Ivan 測試結果 A 之前）的「崇拜程序」分頁定義，**寫死凍結**。
 *
 * ⚠️ 為甚麼要寫死：v3 改了 `contentSheetWorshipTabDef_()`（拿走第 L 至 Q 欄的浸禮六欄，加「詩班項目名稱」）。
 *    v2 → v3 移轉測試要造一份「真的是 v2」的內容表；由 src 衍生的話，src 一改測試就靜靜地測一件不存在的事
 *    （docs/已知bug類型.md 事故一、bug class 39）。
 *
 *    內容抄自 commit 6df1519 的 `src/ContentSheet.gs` `contentSheetWorshipTabDef_()`（第 1、2 行）。其餘分頁
 *    （家事報告、代禱事項、團契聚會、財政報告、崇拜人數）v2 與 v3 相同，由 src 造。**這個檔案以後不可以再改**。
 */

'use strict';

const LEGACY_V2_WORSHIP_TAB_DEF = Object.freeze({
  tabName: '崇拜程序',
  headers: ['主日日期', '讀經經文', '證道講題', '回應詩歌', '詩班曲名', '有效', '備註',
    '序樂', '宣召出處', '宣召經文', '詩歌頌讚',
    '浸禮主禮', '入會禮主禮', '孩童奉獻禮主禮', '受浸肢體', '入會肢體', '奉獻孩童'],
  keys: ['SERVICE_DATE', 'SCRIPTURE_REF', 'SERMON_TITLE', 'RESPONSE_HYMN', 'CHOIR_TITLE', 'ACTIVE', 'NOTES',
    'PRELUDE', 'CALL_REF', 'CALL_TEXT', 'HYMN_PRAISE',
    'BAPTISM_OFFICIANT', 'MEMBERSHIP_OFFICIANT', 'CHILD_DEDICATION_OFFICIANT',
    'BAPTISM_MEMBERS', 'MEMBERSHIP_MEMBERS', 'CHILD_DEDICATION_CHILDREN']
});

/**
 * 用途：v2 內容表的分頁定義：src 現時的分頁，只把「崇拜程序」換成凍結的 v2 定義。
 * Args:
 *   currentDefs {Object[]} src 的 `contentSheetTabDefs_()`。
 * Returns:
 *   {Object[]} 新陣列。
 */
function legacyContentTabDefsV2(currentDefs) {
  return (currentDefs || []).map(function (d) {
    return d.tabName === '崇拜程序' ? JSON.parse(JSON.stringify(LEGACY_V2_WORSHIP_TAB_DEF)) : d;
  });
}

module.exports = { legacyContentTabDefsV2: legacyContentTabDefsV2, LEGACY_V2_WORSHIP_TAB_DEF: LEGACY_V2_WORSHIP_TAB_DEF };
