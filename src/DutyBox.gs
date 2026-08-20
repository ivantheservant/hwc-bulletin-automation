/**
 * DutyBox.gs
 *
 * 事奉框：把職事表快照的 slot，套上週報自己的 `PostDisplay`（顯示名稱、
 * 次序、哪一頁出現、合併組）與 `MergeGroups`（合併規則），組成第 1 頁的
 * 事奉框、或第 3 頁的「下週事奉」清單。
 *
 * 分兩層：
 *   - `buildDutyBox_(snapshot, page)`　真正入口，讀工作表與 Config。
 *   - `buildDutyBoxRows_(input)`　　　純函式，全部資料由呼叫方傳進來，
 *     不碰 Apps Script 服務，方便在 Node 直接測試。
 */

'use strict';

/**
 * 用途：取得某一頁在 `PostDisplay` 工作表對應的四個機器鍵。第 1 頁與
 *   第 3 頁的欄位是平行的一組，用這個函式集中對照，避免每個地方各自
 *   拼字串而拼錯。
 * Args:
 *   page {number} 1 或 3。
 * Returns:
 *   {{name:string, order:string, show:string, merge:string}}
 * Raises:
 *   Error 如果 page 不是 1 或 3。
 */
function dutyBoxPageKeys_(page) {
  if (page === 1) {
    return { name: 'PAGE1_NAME', order: 'PAGE1_ORDER', show: 'SHOW_ON_PAGE1', merge: 'PAGE1_MERGE_GROUP' };
  }
  if (page === 3) {
    return { name: 'PAGE3_NAME', order: 'PAGE3_ORDER', show: 'SHOW_ON_PAGE3', merge: 'PAGE3_MERGE_GROUP' };
  }
  throw new Error('dutyBoxPageKeys_：page 只可以是 1 或 3，收到：' + JSON.stringify(page));
}

/**
 * 用途：事奉框的真正入口。讀週報自己的 `PostDisplay`／`MergeGroups`／
 *   `PersonDisplay` 工作表與相關 Config，再交給純函式層組裝。
 * Args:
 *   snapshot {Object} readRosterSnapshot_() 的回傳值。
 *   page {number} 1（第 1 頁事奉框）或 3（第 3 頁下週事奉）。
 *   warnings {Object[]=} 選填，累積警告用的陣列。
 * Returns:
 *   {Object[]} 事奉框資料列，形狀見 buildDutyBoxRows_()。
 * Raises:
 *   Error 如果 page 不是 1 或 3，或任何一張工作表讀取失敗。
 */
function buildDutyBox_(snapshot, page, warnings) {
  var honorificKey = page === 1 ? CONFIG_KEYS.HONORIFIC_ON_PAGE1 : CONFIG_KEYS.HONORIFIC_ON_PAGE3;
  var honorificRaw = getConfig(honorificKey, page === 1 ? 'TRUE' : 'FALSE');

  return buildDutyBoxRows_({
    snapshot: snapshot,
    page: page,
    postDisplayRows: readSheet(SHEETS.POST_DISPLAY),
    mergeGroupRows: readSheet(SHEETS.MERGE_GROUPS),
    personDisplayRows: readSheet(SHEETS.PERSON_DISPLAY),
    withHonorific: normalizeBoolean_(honorificRaw) === true,
    targetDate: normalizeDate_(snapshot.isoDate),
    warnings: warnings || []
  });
}

/**
 * 用途：事奉框的純函式層。把 slot 依 `PostDisplay` 的次序與合併規則組成
 *   一行一行的顯示資料。
 *
 *   處理次序：
 *     1. 篩出 `ACTIVE=TRUE` 且該頁 `SHOW_ON_PAGEn=TRUE` 的崗位，按
 *        `PAGEn_ORDER` 排序。
 *     2. 每個崗位取自己的 slot，先丟掉 `NOT_APPLICABLE` 的——這一步做在
 *        最前面，因為結構性不適用代表**整行不出現**，不應該影響後面的
 *        合併判斷（例如某個崗位這一週不適用，不代表它的合併組整組消失）。
 *     3. 決定每個合併組要不要合併（見下），再依次序輸出。
 *
 *   合併規則：
 *     - `MERGE_ONLY_IF_SAME_PERSON=TRUE`（例如 `MG_CHAIR_ANNOUNCE`）：
 *       只有當組內全部崗位都由**同一個 PersonID** 擔任時才合併成一行，
 *       顯示 `MergeGroups.DISPLAY_NAME`（主席及報告）；否則不合併，
 *       各自用自己的 `PAGEn_NAME` 顯示成兩行。
 *     - `MERGE_ONLY_IF_SAME_PERSON=FALSE`（例如 `MG_AV`）：永遠合併成
 *       一行，顯示 `DISPLAY_NAME`（影音），姓名用 `JOIN_SEPARATOR` 串起來，
 *       按組內 `PAGEn_ORDER` 排序，重複的姓名只出現一次。
 * Args:
 *   input {{snapshot:Object, page:number, postDisplayRows:Object[],
 *          mergeGroupRows:Object[], personDisplayRows:Object[],
 *          withHonorific:boolean, targetDate:(Date|null),
 *          warnings:Object[]}}
 * Returns:
 *   {{label:string, text:string, postIds:string[], states:string[],
 *     isPending:boolean}[]} 依顯示次序排好的事奉框資料列。整組都
 *     `NOT_APPLICABLE` 的崗位／合併組不會出現在結果內。
 * Raises:
 *   Error 如果 `input.page` 不是 1 或 3。
 */
function buildDutyBoxRows_(input) {
  var pageKeys = dutyBoxPageKeys_(input.page);
  var warnings = input.warnings || [];
  var slotsByPost = (input.snapshot && input.snapshot.slotsByPost) || {};

  var displayOptions = {
    withHonorific: input.withHonorific === true,
    personDisplayRows: input.personDisplayRows || [],
    targetDate: input.targetDate || null,
    warnings: warnings
  };

  // ---- 1. 篩出這一頁要顯示的崗位，按次序排好 ----
  var posts = (input.postDisplayRows || [])
    .filter(function (r) { return r.ACTIVE === true && r[pageKeys.show] === true; })
    .slice()
    .sort(function (a, b) { return (a[pageKeys.order] || 0) - (b[pageKeys.order] || 0); });

  // ---- 2. 每個崗位取 slot，先丟掉結構性不適用的 ----
  var usableSlotsByPostId = {};
  posts.forEach(function (post) {
    usableSlotsByPostId[post.POST_ID] = (slotsByPost[post.POST_ID] || []).filter(function (slot) {
      return slot.state !== ROSTER_SLOT_STATE_.NOT_APPLICABLE;
    });
  });

  // ---- 3. 收集合併組，並決定每一組要不要合併 ----
  var groupPosts = {};
  posts.forEach(function (post) {
    var groupId = String(post[pageKeys.merge] || '').trim();
    if (!groupId) return;
    if (!groupPosts[groupId]) groupPosts[groupId] = [];
    groupPosts[groupId].push(post);
  });

  var groupDecisions = {};
  Object.keys(groupPosts).forEach(function (groupId) {
    groupDecisions[groupId] = decideDutyBoxMerge_(
      groupId, groupPosts[groupId], usableSlotsByPostId, input.mergeGroupRows, warnings
    );
  });

  // ---- 4. 依次序輸出 ----
  var rows = [];
  var emittedGroups = {};

  posts.forEach(function (post) {
    var groupId = String(post[pageKeys.merge] || '').trim();
    var decision = groupId ? groupDecisions[groupId] : null;

    if (decision && decision.willMerge) {
      // 合併組只在**第一個**（次序最前）成員的位置輸出一次。
      if (emittedGroups[groupId]) return;
      emittedGroups[groupId] = true;

      var groupRow = buildMergedDutyBoxRow_(
        decision, groupPosts[groupId], usableSlotsByPostId, pageKeys, displayOptions
      );
      if (groupRow) rows.push(groupRow);
      return;
    }

    // 不合併（本來就沒有合併組，或者同人才合併但不是同一人）→ 各自一行。
    var singleRow = buildSingleDutyBoxRow_(post, usableSlotsByPostId[post.POST_ID], pageKeys, displayOptions);
    if (singleRow) rows.push(singleRow);
  });

  return rows;
}

/**
 * 用途：決定一個合併組這一次要不要合併。
 * Args:
 *   groupId {string} 合併組 ID。
 *   groupPostRows {Object[]} 屬於這一組、而且這一頁要顯示的 `PostDisplay` 資料列。
 *   usableSlotsByPostId {Object<string,Object[]>} 已經濾掉 NOT_APPLICABLE 的 slot。
 *   mergeGroupRows {Object[]} `MergeGroups` 工作表資料列。
 *   warnings {Object[]} 累積警告用的陣列。
 * Returns:
 *   {{willMerge:boolean, groupRow:(Object|null)}} `groupRow` 是 `MergeGroups`
 *     的定義列；找不到定義時 `willMerge` 為 false（退回各自一行）。
 */
function decideDutyBoxMerge_(groupId, groupPostRows, usableSlotsByPostId, mergeGroupRows, warnings) {
  var groupRow = (mergeGroupRows || []).filter(function (r) {
    return r.GROUP_ID === groupId && r.ACTIVE === true;
  })[0] || null;

  if (!groupRow) {
    warnings.push({
      code: 'MERGE_GROUP_NOT_FOUND',
      message: 'PostDisplay 指向的合併組「' + groupId + '」在 MergeGroups 找不到生效中的定義，'
        + '這一次先各自顯示成獨立一行。請檢查 MergeGroups 工作表。'
    });
    return { willMerge: false, groupRow: null };
  }

  var postsWithSlots = groupPostRows.filter(function (p) {
    return (usableSlotsByPostId[p.POST_ID] || []).length > 0;
  });
  if (postsWithSlots.length === 0) {
    // 整組都不適用——連合併與否都不用談，輸出時自然沒有這一行。
    return { willMerge: false, groupRow: groupRow };
  }

  if (groupRow.MERGE_ONLY_IF_SAME_PERSON !== true) {
    return { willMerge: true, groupRow: groupRow };
  }

  // 只在同一人時合併：組內每個崗位都要有 slot，而且全部 slot 指向同一個
  // 非空 PersonID。任何一個崗位未排人（PersonID 為 null）都不算同一人——
  // 「主席未定、報告是甲」不可以顯示成「主席及報告：甲」。
  if (postsWithSlots.length !== groupPostRows.length) {
    return { willMerge: false, groupRow: groupRow };
  }

  var personIds = {};
  var sawEmpty = false;
  groupPostRows.forEach(function (p) {
    (usableSlotsByPostId[p.POST_ID] || []).forEach(function (slot) {
      if (slot.personId) personIds[slot.personId] = true;
      else sawEmpty = true;
    });
  });

  var willMerge = !sawEmpty && Object.keys(personIds).length === 1;
  return { willMerge: willMerge, groupRow: groupRow };
}

/**
 * 用途：組出一個「不合併」崗位的事奉框資料列。同一個崗位有多個 slot
 *   （司事 2 位、聖餐輔禮 4 位）會合併成一格，姓名用一個半形空格分隔，
 *   按 `slotIndex` 排序，重複的姓名只出現一次。
 * Args:
 *   post {Object} `PostDisplay` 的一行。
 *   usableSlots {Object[]} 已經濾掉 NOT_APPLICABLE 的 slot。
 *   pageKeys {Object} dutyBoxPageKeys_() 的輸出。
 *   displayOptions {Object} 傳給 resolveSlotDisplay_() 的 options。
 * Returns:
 *   {?Object} 事奉框資料列；沒有任何可用 slot 時回 `null`（該行不出現）。
 */
function buildSingleDutyBoxRow_(post, usableSlots, pageKeys, displayOptions) {
  var slots = usableSlots || [];
  if (slots.length === 0) return null;

  var ordered = slots.slice().sort(function (a, b) { return (a.slotIndex || 0) - (b.slotIndex || 0); });
  var texts = ordered.map(function (slot) { return resolveSlotDisplay_(slot, displayOptions); });

  return {
    label: String(post[pageKeys.name] || ''),
    text: joinDutyBoxNames_(texts, ' '),
    postIds: [post.POST_ID],
    states: ordered.map(function (s) { return s.state; }),
    isPending: ordered.some(function (s) { return s.state === ROSTER_SLOT_STATE_.PENDING; })
  };
}

/**
 * 用途：組出一個「合併組」的事奉框資料列。組內崗位按該頁 `PAGEn_ORDER`
 *   排序，每個崗位內部再按 `slotIndex` 排序，姓名用 `JOIN_SEPARATOR`
 *   串起來，重複的姓名只出現一次（同一個人同時擔任音響與 PPT 時，
 *   「影音」那一格只出現一次他的名字）。
 * Args:
 *   decision {Object} decideDutyBoxMerge_() 的輸出。
 *   groupPostRows {Object[]} 這一組的 `PostDisplay` 資料列。
 *   usableSlotsByPostId {Object<string,Object[]>} 已濾掉 NOT_APPLICABLE 的 slot。
 *   pageKeys {Object} dutyBoxPageKeys_() 的輸出。
 *   displayOptions {Object} 傳給 resolveSlotDisplay_() 的 options。
 * Returns:
 *   {?Object} 事奉框資料列；整組都沒有可用 slot 時回 `null`。
 */
function buildMergedDutyBoxRow_(decision, groupPostRows, usableSlotsByPostId, pageKeys, displayOptions) {
  var separator = decision.groupRow ? String(decision.groupRow.JOIN_SEPARATOR || ' ') : ' ';

  var orderedPosts = groupPostRows.slice().sort(function (a, b) {
    return (a[pageKeys.order] || 0) - (b[pageKeys.order] || 0);
  });

  var texts = [];
  var postIds = [];
  var states = [];

  orderedPosts.forEach(function (post) {
    var slots = (usableSlotsByPostId[post.POST_ID] || []).slice().sort(function (a, b) {
      return (a.slotIndex || 0) - (b.slotIndex || 0);
    });
    if (slots.length === 0) return;
    postIds.push(post.POST_ID);
    slots.forEach(function (slot) {
      states.push(slot.state);
      texts.push(resolveSlotDisplay_(slot, displayOptions));
    });
  });

  if (postIds.length === 0) return null;

  return {
    label: String(decision.groupRow.DISPLAY_NAME || ''),
    text: joinDutyBoxNames_(texts, separator),
    postIds: postIds,
    states: states,
    isPending: states.indexOf(ROSTER_SLOT_STATE_.PENDING) !== -1
  };
}

/**
 * 用途：把一組顯示文字串成一格的內容：丟掉空白（未排人的 slot 不應該在
 *   版面上留下多餘的分隔符）、重複的只保留第一次出現，再用指定分隔符串起來。
 * Args:
 *   texts {(string|null)[]} 各 slot 的顯示文字。
 *   separator {string} 分隔符。
 * Returns:
 *   {string} 全部都是空白時回空字串。
 */
function joinDutyBoxNames_(texts, separator) {
  var seen = {};
  var kept = [];
  (texts || []).forEach(function (t) {
    var text = String(t === null || t === undefined ? '' : t).trim();
    if (!text) return;
    if (seen[text]) return;
    seen[text] = true;
    kept.push(text);
  });
  return kept.join(separator);
}
