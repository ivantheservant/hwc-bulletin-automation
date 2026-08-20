/**
 * PersonDisplay.gs
 *
 * 把「職事表給的 PersonID ＋ 姓名快照」轉換成「週報上真正要印的那一串
 * 文字」：套用週報自己的 `PersonDisplay` 工作表（尊稱、顯示覆寫、生效
 * 日期），再依頁面決定加不加尊稱。
 *
 * 這個檔案全部是純函式：`PersonDisplay` 工作表的資料由呼叫方讀好傳進來
 * （`options.personDisplayRows`），完全不碰 Apps Script 服務，方便在 Node
 * 直接測試。
 */

'use strict';

/**
 * 用途：判斷一個尊稱是不是「職稱類」尊稱。
 *
 *   ⚠️ 為什麼要分兩類：`HONORIFIC_ON_PAGE1`／`HONORIFIC_ON_PAGE3` 這兩個
 *   設定控制的其實只有「弟兄／姊妹」。核對過印刷版樣本，第 3 頁凡是有
 *   牧師／師母職稱的肢體都**完整保留了職稱**，只有弟兄姊妹被省略——因為
 *   職稱是那個人的身分（漏了是失禮），而弟兄姊妹只是一般敬稱（第 3 頁
 *   版面緊，省掉不影響辨識）。所以職稱類尊稱**無論哪一頁都要顯示**，
 *   不受 `HONORIFIC_ON_PAGEn` 控制。
 *
 *   （這裡刻意不引用樣本上的真實姓名——本 repo 會公開到 GitHub，
 *   原始碼與文件一律不得出現真實會友姓名。）
 * Args:
 *   honorific {string} `PersonDisplay.HONORIFIC` 的值。
 * Returns:
 *   {boolean} 是職稱類（牧師／師母／傳道／宣教士）就回 true。
 */
function isTitleHonorific_(honorific) {
  var h = String(honorific || '').trim();
  if (!h) return false;
  return [
    HONORIFIC.PASTOR,
    HONORIFIC.PASTORS_WIFE,
    HONORIFIC.MINISTER,
    HONORIFIC.MISSIONARY
  ].indexOf(h) !== -1;
}

/**
 * 用途：在 `PersonDisplay` 資料列中，找出指定 PersonID 在指定日期生效的
 *   那一行。條件：`PERSON_ID` 相符、`ACTIVE` 為 TRUE、目標日期落在
 *   `EFFECTIVE_FROM`～`EFFECTIVE_TO` 之內（兩欄留空代表不限）。
 * Args:
 *   personId {string} 要查的 PersonID。
 *   rows {Object[]} `PersonDisplay` 工作表的資料列（readSheet 的輸出）。
 *   targetDate {?Date} 目標主日日期；`null` 代表不做生效日期篩選。
 * Returns:
 *   {?Object} 找到的資料列；找不到回 `null`。同時符合多行時取**第一行**
 *     （工作表由人手維護，重複本來就不應該出現）。
 */
function findPersonDisplayRow_(personId, rows, targetDate) {
  if (!personId) return null;

  var matches = (rows || []).filter(function (row) {
    if (row.PERSON_ID !== personId) return false;
    if (row.ACTIVE !== true) return false;
    if (targetDate instanceof Date) {
      if (row.EFFECTIVE_FROM instanceof Date && targetDate.getTime() < row.EFFECTIVE_FROM.getTime()) return false;
      if (row.EFFECTIVE_TO instanceof Date && targetDate.getTime() > row.EFFECTIVE_TO.getTime()) return false;
    }
    return true;
  });

  return matches.length > 0 ? matches[0] : null;
}

/**
 * 用途：把一個人在週報上的顯示文字算出來。
 *
 *   規則（依序）：
 *     1. `DISPLAY_OVERRIDE` 有值 → 直接用它，**不加任何尊稱**
 *        （覆寫就是完全覆寫，包括尊稱在內；否則「覆寫」這個功能就沒辦法
 *        用來處理「這個人這一次要用另一個稱呼」的情況）。
 *     2. 否則用職事表的姓名快照，再依 `withHonorific` 與尊稱類別決定
 *        要不要在後面接上尊稱。職稱類尊稱一律接上（見 isTitleHonorific_()）。
 *     3. 找不到 `PersonDisplay` 那一行 → 用原名，並記一筆
 *        `NO_PERSON_DISPLAY` 警告。⚠️ **不可以靜靜當成「這個人沒有尊稱」**
 *        ——尊稱缺失是要有人去補資料的問題，不是正常狀態。
 * Args:
 *   personId {string} 職事表的 PersonID，可以是空字串（例如佔位符 slot）。
 *   nameSnapshot {string} 職事表的姓名快照，作為找不到覆寫時的底稿。
 *   options {{withHonorific:boolean, personDisplayRows:Object[],
 *            targetDate:(Date|null), warnings:(Object[]|undefined)}}
 *     `withHonorific` 由 Config 的 `HONORIFIC_ON_PAGE1`／`HONORIFIC_ON_PAGE3`
 *     決定，只影響「弟兄／姊妹」這類一般敬稱。
 * Returns:
 *   {string} 要印在週報上的文字。
 */
function resolvePersonDisplay_(personId, nameSnapshot, options) {
  var opts = options || {};
  var baseName = String(nameSnapshot || '').trim();
  var row = findPersonDisplayRow_(personId, opts.personDisplayRows, opts.targetDate || null);

  if (!row) {
    if (personId && opts.warnings) {
      opts.warnings.push({
        code: 'NO_PERSON_DISPLAY',
        personId: personId,
        name: baseName,
        message: 'PersonID「' + personId + '」（' + (baseName || '無姓名快照')
          + '）在週報的 PersonDisplay 工作表找不到生效中的一行，已直接用職事表的姓名快照，沒有加尊稱。'
          + '請在 PersonDisplay 補上這個人的尊稱設定。'
      });
    }
    return baseName;
  }

  var override = String(row.DISPLAY_OVERRIDE || '').trim();
  if (override) return override;

  var honorific = String(row.HONORIFIC || '').trim();
  if (!honorific) return baseName;
  if (!opts.withHonorific && !isTitleHonorific_(honorific)) return baseName;

  return baseName + honorific;
}

/**
 * 用途：在 `PersonDisplay` 資料列中，用**姓名**（而不是 PersonID）找出
 *   在指定日期生效的那一行。
 *
 *   ⚠️ 為什麼需要按姓名找：第六輪的人手覆寫（`DutyOverride.OVERRIDE_NAME`）
 *   存的是**顯示用的姓名文字**，不是 PersonID——幹事可能填一個職事表根本
 *   沒有的人（例如臨時幫忙的訪客），那種情況下根本沒有 PersonID 可用。
 *   但如果填的名字剛好對得上某位肢體，尊稱仍然應該照樣套用，所以要有
 *   這條按姓名查的路徑。
 * Args:
 *   nameTC {string} 要查的姓名。
 *   rows {Object[]} `PersonDisplay` 工作表的資料列。
 *   targetDate {?Date} 目標主日日期；`null` 代表不做生效日期篩選。
 * Returns:
 *   {?Object} 找到的資料列；找不到回 `null`。同時符合多行時取**第一行**。
 */
function findPersonDisplayRowByName_(nameTC, rows, targetDate) {
  var name = String(nameTC || '').trim();
  if (!name) return null;

  var matches = (rows || []).filter(function (row) {
    if (String(row.NAME_TC || '').trim() !== name) return false;
    if (row.ACTIVE !== true) return false;
    if (targetDate instanceof Date) {
      if (row.EFFECTIVE_FROM instanceof Date && targetDate.getTime() < row.EFFECTIVE_FROM.getTime()) return false;
      if (row.EFFECTIVE_TO instanceof Date && targetDate.getTime() > row.EFFECTIVE_TO.getTime()) return false;
    }
    return true;
  });

  return matches.length > 0 ? matches[0] : null;
}

/**
 * 用途：把一個**人手覆寫的姓名**算成週報上要印的文字。
 *
 *   規則跟 resolvePersonDisplay_() 一樣（`DISPLAY_OVERRIDE` 優先、職稱類
 *   尊稱一律保留、一般敬稱受 `withHonorific` 控制），差別只在於查
 *   `PersonDisplay` 是**按姓名**而不是按 PersonID。
 *
 *   ⚠️ 對不上任何一位肢體時，**原樣顯示覆寫的姓名並記一筆 warning**，
 *   不拋錯——幹事填一個職事表沒有的人（臨時幫忙的訪客）是完全正常的
 *   使用情境，週報照樣要印得出來；warning 只是讓「這個名字沒有尊稱設定」
 *   這件事看得見，不是錯誤。
 * Args:
 *   overrideName {string} `DutyOverride.OVERRIDE_NAME` 的值。
 *   options {{withHonorific:boolean, personDisplayRows:Object[],
 *            targetDate:(Date|null), warnings:(Object[]|undefined)}}
 *     同 resolvePersonDisplay_() 的 options。
 * Returns:
 *   {string} 要印在週報上的文字。
 */
function resolveOverrideDisplay_(overrideName, options) {
  var opts = options || {};
  var name = String(overrideName || '').trim();
  if (!name) return '';

  var row = findPersonDisplayRowByName_(name, opts.personDisplayRows, opts.targetDate || null);

  if (!row) {
    if (opts.warnings) {
      opts.warnings.push({
        code: 'OVERRIDE_NAME_NOT_IN_PERSON_DISPLAY',
        name: name,
        message: '人手覆寫的姓名「' + name + '」在週報的 PersonDisplay 工作表找不到生效中的一行，'
          + '已原樣顯示，沒有加尊稱。如果這是本堂肢體，可以在 PersonDisplay 補上他的尊稱設定；'
          + '如果是臨時幫忙的訪客，這是正常的，可以不理。'
      });
    }
    return name;
  }

  var override = String(row.DISPLAY_OVERRIDE || '').trim();
  if (override) return override;

  var honorific = String(row.HONORIFIC || '').trim();
  if (!honorific) return name;
  if (!opts.withHonorific && !isTitleHonorific_(honorific)) return name;

  return name + honorific;
}

/**
 * 用途：依 slot 的 `state` 決定那一格應該顯示什麼文字。
 *
 *   | state | 顯示 |
 *   |---|---|
 *   | `NOT_APPLICABLE` | 回 `null`——代表**整個崗位那一行不出現**，不是顯示「—」 |
 *   | `EXTERNAL` | 負責單位名稱（例如「英語堂敬拜隊」） |
 *   | `ASSIGNED` | 經 resolvePersonDisplay_() 算出來的姓名 |
 *   | `PENDING` | 空字串（版面上留白，同時會被 BulletinModel 列入待填清單） |
 *
 *   ⚠️ `slot.hasOverride` 為 true 時走 resolveOverrideDisplay_()（按姓名查
 *   `PersonDisplay`），因為覆寫存的是姓名文字而不是 PersonID。這個判斷
 *   放在 `state` 之後——`NOT_APPLICABLE` 仍然勝過覆寫（結構先於內容，
 *   見 docs/已知bug類型.md 事故五與 src/DutyOverride.gs 的說明），而
 *   `applyDutyOverridesToSlots_()` 本來就不會替 `NOT_APPLICABLE` 的 slot
 *   設 `hasOverride`。
 * Args:
 *   slot {Object} buildRosterSlotIndex_() 產生、可能經
 *     applyDutyOverridesToSlots_() 套過覆寫的 slot。
 *   options {Object} 同 resolvePersonDisplay_() 的 options。
 * Returns:
 *   {?string} 要顯示的文字；`null` 代表這一行整行不出現。
 */
function resolveSlotDisplay_(slot, options) {
  if (!slot) return null;

  switch (slot.state) {
    case ROSTER_SLOT_STATE_.NOT_APPLICABLE:
      return null;
    case ROSTER_SLOT_STATE_.EXTERNAL:
      return String(slot.externalOwner || '').trim();
    case ROSTER_SLOT_STATE_.PENDING:
      return '';
    default:
      if (slot.hasOverride) return resolveOverrideDisplay_(slot.overrideName, options);
      return resolvePersonDisplay_(slot.personId, slot.personName, options);
  }
}
