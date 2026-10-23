#!/usr/bin/env node
/**
 * tests/fixtures/legacyContentSheetV1.js
 *
 * 內容表 **v1**（工作介面精簡之前）的分頁定義，**寫死凍結**。
 *
 * ⚠️ 為甚麼要寫死、而不是由 src 衍生：內容表 v2 會改 `contentSheetTabDefs_()`
 *    （「宣召」「浸禮合堂」併入「崇拜程序」）。移轉測試要造一份「真的是舊版」
 *    的內容表（2027T4、2028T2 現時就是這個樣子），如果由 src 衍生，src 一改，
 *    測試造出來的「舊版」就跟住變成新版，移轉測試會靜靜地測一件不存在的事
 *    （docs/已知bug類型.md 事故一、bug class 39）。
 *
 *    內容抄自 commit ed42537 的 `src/ContentSheet.gs` `contentSheetTabDefs_()`，
 *    只留建立分頁需要的三樣：分頁名稱、第 1 行中文標題、第 2 行機器鍵。
 *    **這個檔案以後不可以再改**（除非真的發現抄錯了 ed42537 的內容）。
 */

'use strict';

/**
 * 用途：v1 內容表八張資料分頁的定義（次序就是 v1 的分頁次序，`_說明` 不在內）。
 * Args: （無）
 * Returns:
 *   {{tabName:string, headers:string[], keys:string[]}[]} 每次回傳一份新的副本，
 *     呼叫方改了也不會影響下一次。
 */
function legacyContentTabDefsV1() {
  return JSON.parse(JSON.stringify(LEGACY_V1_TAB_DEFS));
}

/**
 * 用途：按分頁名稱取 v1 的一張分頁定義。
 * Args:
 *   tabName {string}
 * Returns:
 *   {?{tabName:string, headers:string[], keys:string[]}} 找不到回 `null`。
 */
function legacyContentTabDefV1(tabName) {
  return legacyContentTabDefsV1().filter(function (d) { return d.tabName === tabName; })[0] || null;
}

const LEGACY_V1_TAB_DEFS = Object.freeze([
  {
    tabName: '家事報告',
    headers: ['主日日期', '次序', '內容', '連續到', '有效', '來源', '原文備份'],
    keys: ['SERVICE_DATE', 'SEQ_NO', 'TEXT', 'REPEAT_UNTIL', 'ACTIVE', 'SOURCE', 'SOURCE_SNAPSHOT']
  },
  {
    tabName: '代禱事項',
    headers: ['主日日期', '次序', '內容', '連續到', '有效'],
    keys: ['SERVICE_DATE', 'SEQ_NO', 'TEXT', 'REPEAT_UNTIL', 'ACTIVE']
  },
  {
    tabName: '團契聚會',
    headers: ['主日日期', '次序', '團契', '日期', '時間', '週會內容', '有效'],
    keys: ['SERVICE_DATE', 'SEQ_NO', 'NAME', 'DATE_TEXT', 'TIME_TEXT', 'CONTENT', 'ACTIVE']
  },
  {
    tabName: '財政報告',
    headers: ['主日日期', '次序', '報告標題', '項目', '欄一', '欄二', '欄三', '欄四', '有效'],
    keys: ['SERVICE_DATE', 'SEQ_NO', 'TITLE_OVERRIDE', 'ROW_LABEL', 'COL1', 'COL2', 'COL3', 'COL4', 'ACTIVE']
  },
  {
    tabName: '崇拜人數',
    headers: [
      '崇拜日期',
      '英語堂崇拜', '粵語堂東區崇拜', '粵語堂北岸崇拜', '華語堂崇拜',
      '英語堂祈禱會', '粵語堂東區祈禱會', '粵語堂北岸祈禱會', '華語堂祈禱會',
      '英語堂兒童', '粵語堂東區兒童', '粵語堂北岸兒童', '華語堂兒童',
      '有效'
    ],
    keys: [
      'SERVICE_DATE',
      'ATT_ENG_WORSHIP', 'ATT_CANE_WORSHIP', 'ATT_CANN_WORSHIP', 'ATT_MAN_WORSHIP',
      'ATT_ENG_PRAYER', 'ATT_CANE_PRAYER', 'ATT_CANN_PRAYER', 'ATT_MAN_PRAYER',
      'ATT_ENG_CHILD', 'ATT_CANE_CHILD', 'ATT_CANN_CHILD', 'ATT_MAN_CHILD',
      'ACTIVE'
    ]
  },
  {
    tabName: '宣召',
    headers: ['主日日期', '宣召出處', '宣召經文', '有效'],
    keys: ['SERVICE_DATE', 'CALL_REF', 'CALL_TEXT', 'ACTIVE']
  },
  {
    tabName: '崇拜程序',
    headers: ['主日日期', '讀經經文', '證道講題', '回應詩歌', '詩班曲名', '有效', '備註'],
    keys: ['SERVICE_DATE', 'SCRIPTURE_REF', 'SERMON_TITLE', 'RESPONSE_HYMN', 'CHOIR_TITLE', 'ACTIVE', 'NOTES']
  },
  {
    tabName: '浸禮合堂',
    headers: [
      '主日日期', '浸禮主禮', '入會禮主禮', '孩童奉獻禮主禮',
      '受浸肢體', '入會肢體', '奉獻孩童', '有效', '備註'
    ],
    keys: [
      'SERVICE_DATE', 'BAPTISM_OFFICIANT', 'MEMBERSHIP_OFFICIANT', 'CHILD_DEDICATION_OFFICIANT',
      'BAPTISM_MEMBERS', 'MEMBERSHIP_MEMBERS', 'CHILD_DEDICATION_CHILDREN', 'ACTIVE', 'NOTES'
    ]
  }
]);

module.exports = {
  legacyContentTabDefsV1: legacyContentTabDefsV1,
  legacyContentTabDefV1: legacyContentTabDefV1
};
