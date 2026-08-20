# 已知 bug 類型

本文件記錄本專案已經發生過、或者刻意要求每次寫程式碼之前反覆自問的
bug 類型。每一類都要在動筆之前先想一遍：這次寫的東西會不會踩中。

---

## 事故一：跨檔案的頂層初始化式依賴 `.gs` 檔案的載入次序（`onOpen` 完全沒有執行）

發生日期：2026-08-20（第一輪之後）

### 現象

在 Apps Script 編輯器手動執行 `onOpen`，執行紀錄顯示：

```
Error   TypeError: Cannot read properties of undefined (reading 'STAND')
        (anonymous) @ Bootstrap.gs:331
```

試算表開啟時完全見不到「週報系統」選單，而且試算表本身沒有任何錯誤
提示——只有進 Script Editor 手動執行才看得到上面這個例外。

### 根因

Apps Script 會按**專案內的檔案次序**（Script Editor 左邊清單的次序，
也就是按檔名字母序）逐個執行每個 `.gs` 檔案的**頂層陳述式**。當時的
實際次序是：

```
AuditLog → Bootstrap → ConfigService → Constants → Diagnostics → Menu → SheetUtils
```

`Bootstrap.gs`（排第 2）有一個頂層 `var SEED_PROGRAM_TEMPLATES_ = [...]`，
內容用到 `POSTURE.STAND` 與 `CONDITION_TYPE.ALWAYS`；而 `POSTURE` 與
`CONDITION_TYPE` 是 `Constants.gs`（排第 4）才宣告的常數。

執行到 `Bootstrap.gs` 的頂層 `var` 陳述式時，`Constants.gs` 根本還沒
執行——`var` 只是被提升（hoisted），這一刻 `POSTURE` 的值是
`undefined`。讀 `undefined.STAND` 直接拋 `TypeError`。

**這個例外發生在整個專案的載入階段**，Apps Script 因此判定專案載入
失敗，`onOpen()` 這個簡易觸發器根本沒有機會被呼叫——選單永遠出不到，
而且因為是載入階段的錯誤，試算表介面上不會有任何提示，只能靠手動在
Script Editor 執行某個函式（例如 `onOpen`）才看得到執行紀錄裡的例外。

第一輪的兩個 Node 測試（`tests/sheetutils.test.js`、
`tests/constants.test.js`）全部通過，完全沒有捉到這個問題——因為當時
`tests/helpers/loadGas.js` 是由呼叫方自己指定載入次序
（`['src/Constants.gs', 'src/SheetUtils.gs']`），把 `Constants.gs` 排在
最前面，跟 Apps Script 的實際次序不同，等於是在一個「修正過」、不存在
的假環境下測試。

### 修法

1. **`Bootstrap.gs` 全部頂層初始化式改為延遲求值。** 函式宣告本身會被
   提升，而且函式**主體只在被呼叫時才執行**，那時候全部檔案都已經
   載入完畢。把每個 `var X_ = [...]` 改寫成 `function x_() { return [...]; }`，
   呼叫端改為呼叫這個函式。具體對照：

   | 原本（頂層 var，載入時就求值） | 改成（函式，呼叫時才求值） |
   |---|---|
   | `var README_CONTENT_LINES_` | `readmeContentLines_()` |
   | `var SEED_POST_DISPLAY_` | `seedPostDisplayRows_()` |
   | `var SEED_MERGE_GROUPS_` | `seedMergeGroupsRows_()` |
   | `var SEED_PROGRAM_TEMPLATES_` | `seedProgramTemplatesRows_()` |
   | `var SEED_EMAIL_TEMPLATES_` | `seedEmailTemplatesRows_()` |

   （注意：新函式名稱刻意跟既有的 seed 協調函式 `seedPostDisplay_()`
   等**加了 `Rows` 字尾**避免撞名——那幾個既有函式是「把資料補進工作表」
   的協調者，新函式是「回傳原始 seed 資料」的資料來源，兩者職責不同，
   不能同名。）

   同一個檔案內部自己引用自己的常數（例如 `Constants.gs` 的 `DEFAULTS`
   引用同檔案較早宣告的 `CONFIG_KEYS`）是可以的——由上而下，不構成
   跨檔案問題。**不允許**的是跨檔案、而且被引用的檔案排在後面。

2. **新增靜態檢查 `tools/lint-load-order.js`。** 掃描 `src/*.gs`，找出
   每個檔案的頂層初始化式，如果引用了「宣告在另一個檔案、而那個檔案
   按檔名字母序排在本檔案之後」的識別碼，就報錯並以非零離開碼結束。
   在**寫程式碼的當下**用靜態分析攔住這一類問題，不需要真的執行一次
   才發現。

3. **`tests/helpers/loadGas.js` 改用真實次序。** 新增
   `loadAllSrcFilesInOrder()`，一律按檔名字母序讀取 `src/` 目錄的實際
   內容並依序載入，不再接受呼叫方手動指定次序。`tests/sheetutils.test.js`
   與 `tests/constants.test.js` 都改用這個函式。這一步的用意是讓
   **執行期**的驗證也套用跟 Apps Script 一致的次序，跟第 2 點的靜態
   檢查互補：一個在寫的時候擋，一個在跑測試的時候驗證「就算擋漏了，
   照真實次序執行也不會出事」。

4. **新增回歸測試 `tests/loadorder.test.js`。** 斷言
   `tools/lint-load-order.js` 對現時的 `src/` 回傳 0 項違規；用刻意
   違規的假原始碼斷言 lint 真的捉得到、也斷言修好之後不會再報；斷言
   按字母序整個載入一次之後，`POSTURE`、`CONDITION_TYPE`、`APP_NAME`
   等跨檔案常數都有值，`seedProgramTemplatesRows_()` 回傳正確的 45 行，
   `onOpen` 這個函式本身有被成功定義出來（這正是事故發生時會壞掉的
   地方）。

### 防止再發生的機制

- `tools/lint-load-order.js`：寫程式碼當下的靜態關卡。
- `tests/helpers/loadGas.js` 的 `loadAllSrcFilesInOrder()`：測試載入
  次序永遠跟 Apps Script 一致，不會再因為「自己揀順序」而漏測。
- `tests/loadorder.test.js`：把以上兩層都納入回歸測試，日後任何人
  不小心引入同類問題，`node tests/loadorder.test.js` 會直接失敗。
- 本文件：提醒日後任何新增 `.gs` 檔案的頂層宣告，一律要問「這個運算式
  會不會在檔案載入的當下就執行？如果會，它有沒有引用到別的檔案？」。

⚠️ **明確不採用的解法：靠改檔名讓 `Constants.gs` 排到最前面。** 檔名
隨時會變（例如日後新增一個 `A開頭.gs`），這樣做不是修正問題，只是把
問題暫時藏起來，遲早會用另一個檔名組合再犯一次。真正的修法是讓頂層
初始化式不依賴任何載入次序——這正是「延遲求值」這個手法的意義。

---

## 事故二：把「自己的工作表」那套嚴格規則套用到「別人的工作表」

發生日期：2026-08-20（第二輪之後）

### 現象

撳「測試讀取職事表」輸入 `2027-10-03`，對話框顯示：

```
測試讀取職事表失敗
職事表工作表「Posts」第 3 行、欄位「AllowConsecutive」的值無法正規化：
normalizeBoolean_：無法判斷是否為 TRUE/FALSE，值 = "ALLOW"
```

### 根因

`Posts.AllowConsecutive` 的實際取值是 `ALLOW`／`BLOCK`／`WARN`，是一個
列舉，不是 boolean。第二輪的 `ROSTER_TABLE_DEFS_` 把職事表七張表的
**完整** schema 照抄過來，並且沿用 `SheetUtils.gs` 的嚴格
`normalizeByType_()` 逐欄正規化——這套規則的假設是「這是我們自己定義的
schema，型別不符代表我們自己有 bug，應該立即拋錯」，套在自己的工作表
上完全正確。

但職事表**不是**我們自己的工作表。硬規則「2026-12-04 之前不可以要求
職事表改動任何一行程式碼」意味著我們對職事表的欄位結構、型別、列舉值
完全沒有話事權。`AllowConsecutive` 這一欄只是徵狀——只要沿用嚴格規則，
職事表任何一次加欄、任何一個我們沒預期到的取值，都會讓整個讀取直接
拋錯，而我們沒有辦法要求對方配合。真正的問題是**分不清「自己的表」跟
「別人的表」，把同一套規則用在兩種性質完全相反的資料來源上**。

### 修法

在 `src/RosterRead.gs` 建立一套**只給職事表用**的解析函式
（`rosterToText_()`／`rosterToIntLenient_()`／`rosterToDateLenient_()`／
`rosterIsTrueValue_()`），與 `SheetUtils.gs` 的 `normalize*_()` 完全
分開，不共用：

1. **白名單欄位**：`ROSTER_TABLE_DEFS_` 從「照抄職事表完整 schema」
   改成「只列週報真正需要的機器鍵」。不在白名單內的欄，即使工作表裡
   有，也完全不會被讀取／正規化／驗證——`AllowConsecutive` 直接從
   `Posts` 的白名單移除，因為週報從來沒用過這一欄。
2. **布林語意照抄職事表**：`rosterIsTrueValue_()` 一字不差複製職事表
   `src/SheetReader.gs` 的 `isTrueValue_()`（`value === true` 或字串
   trim+大寫後等於 `'TRUE'`），空白／`FALSE`／任何其他值一律當
   `false`，永不拋錯——不自己另立一套（例如接受 `是`／`1`／`Y`），
   避免兩邊語意不一致。
3. **整數／日期寬鬆解析**：空白回 `null`；有值但解析不出來回 `null`
   並記一筆 `ROSTER_VALUE_UNPARSEABLE` 警告，不拋錯；日期解析失敗的
   列在後續比對日期時會自動配不到、等於被略過。
4. **只有三種情況才拋錯**：工作表本身不存在、第 2 行缺少白名單內的
   機器鍵、`openById()` 失敗。多出來的欄位一律靜靜略過，不是錯誤。

詳見 [docs/職事表唯讀介面.md](職事表唯讀介面.md) 的「為什麼對職事表
用寬鬆解析」一節。

### 防止再發生的機制

- `docs/職事表唯讀介面.md` 明確記錄白名單與型別表，日後新增欄位需求
  時，先問「這個欄位真的要讀嗎？」，不要整表照抄。
- `tests/rostersnapshot.test.js` 有專門的回歸測試：`AllowConsecutive`
  這類列舉值不會出錯、多出來的未知欄位不會出錯、白名單缺欄會拋錯且
  訊息列出缺哪幾個、寬鬆布林／整數／日期的邊界案例都覆蓋到。
- 本文件：提醒日後讀任何外部系統（不只職事表）的工作表時，先問「這是
  我們自己的表，還是別人的表？」——是別人的表，就要用白名單＋寬鬆
  解析，不可以照抄自己那套嚴格規則。

⚠️ **明確不採用的解法：要求職事表把 `AllowConsecutive` 改成 boolean。**
硬規則禁止要求職事表改動任何一行程式碼；就算職事表那邊願意配合，
「週報的正確性依賴另一個系統配合修改」本身就是脆弱的設計，下一個
類似欄位還是會用同樣的方式讓我們出事。

---

## 事故三：跨執行的快取套用在人手編輯的 `Config` 上

發生日期：2026-08-20（第二輪之後）

### 現象

在 `Config` 填入 `ROSTER_SPREADSHEET_ID` 之後，系統仍然顯示「尚未設定
職事表位置」，要撳一次「重新載入設定（唯讀）」才生效。

### 根因

`src/ConfigService.gs` 在 `loadConfigCache_()` 之上多加了一層
`CacheService`（跨執行、TTL 6 小時）：先查 `CacheService`，有命中就
直接回傳，完全不讀工作表。`Config` 是幹事會人手編輯的工作表，只有約
30 行，每次執行讀一次的成本可以忽略——加這層快取本來是想省一個幾乎
不存在的成本，代價卻是人手改完 `Config` 要等最多 6 小時、或者記得手動
撳選單「重新載入設定」才生效。這正是「同一個狀態有兩個真相來源，只
更新了其中一個」：`Config` 工作表本身已經改了，但 `CacheService` 裡的
舊值沒有跟著更新，而且完全沒有任何錯誤訊息，只會表現成「設定好像沒有
寫入」。

### 修法

刪除 `CONFIG_CACHE_SERVICE_KEY_`、快取存活時間常數，以及所有跨執行
快取服務的讀寫呼叫。**保留**單次執行內的記憶體快取（`CONFIG_CACHE_`）
——它每次執行都是全新的，不會有陳舊資料的問題，而且省下的是同一次
執行內重覆呼叫 `getConfig()` 的成本，跟「改完不生效」完全無關。
`clearConfigCache_()` 與選單「重新載入設定（唯讀）」都保留，現在單純
是「顯示目前設定值」的用途。

### 防止再發生的機制

- `tests/configcache.test.js`：斷言 `getConfig()` 在同一次執行內只讀
  一次工作表（記憶體快取仍然有效），也斷言原始碼內不再出現任何跨執行
  快取服務的呼叫。
- 本文件：提醒日後任何「人手編輯的資料」都不可以加跨執行、有存活時間
  的快取——先問「這份資料多久會被人手改一次？改完之後，下一個讀到
  舊值的人要等多久、會不會有任何提示？」。單次執行內的記憶體快取沒有
  這個問題，可以放心用。

---

## 事故四：用一個「對方根本不填」的欄位來查表（特別主日永遠查不到）

發生日期：2026-08-20（第二輪之後）

### 現象

2027-10-03 在職事表顯示為「主日崇拜（十月主日（浸禮））」，但週報的
「測試讀取職事表」顯示「特別主日：（無）」。

### 根因

我們用 `ServiceDates.SpecialID` 去 `SpecialSundays` 查表，但那一欄在
**實際資料裡是空的**。職事表自己**從來不用 `SpecialID` 做這件事**——它的
`buildSpecialSundayTitleIndex_()`（`src/RosterWriter.gs`）是按日期建索引的：

```js
readSpecialSundays(quarterId).forEach(function (row) {
  if (!isTrueValue_(row[ACTIVE])) return;
  const dateStr = toDateString(row[SERVICE_DATE], timezone);
  if (!dateStr) return;
  const title = String(row[TITLE] || '').trim() || String(row[TYPE] || '').trim();
  if (title) index[dateStr] = title;
});
```

我們看見職事表 schema 裡有一個 `SpecialID` 欄、名字看起來就是用來做關聯的，
就假設它是查表的鍵——但**欄位存在不代表對方會填它**。這是事故二（把別人
系統的欄位當成自己的型別假設）的近親：那一次錯在假設對方的**型別**，
這一次錯在假設對方的**使用方式**。

更糟的是這個 bug 完全靜默：查不到就是 `special: null`，跟「這一週真的沒有
特別主日」一模一樣，沒有任何錯誤訊息。

### 修法

1. `RosterRead.gs` 改為建立「日期字串 → `SpecialSundays` 資料列」的索引
   （`buildSpecialSundayDateIndex_()`），只收 `Active` 為 TRUE、而且屬於
   該季度的列，用 `yyyy-MM-dd` 比對。
2. `special.title` 的取值規則也照抄職事表：`Title` 有值就用 `Title`，
   否則用 `Type`。
3. `ServiceDates.SpecialID` 只作**參考記錄**保留在 `snapshot.serviceDate`，
   不再用來查表。如果它有值、而按日期查到的是另一列（或查不到），記一筆
   `SPECIAL_SUNDAY_ID_MISMATCH` 警告——讓人看得見兩處資料不一致，但仍然
   以日期為準。

### 防止再發生的機制

- `tests/rostersnapshot.test.js` 的 Prompt3-1～3-6：`SpecialID` 空白但日期
  對得上要查得到、日期對不上要查不到、`Title`／`Type` 的取捨、
  `SpecialID` 不一致要記警告、索引只收同季度。
- 本文件：提醒日後要用外部系統的任何欄位做關聯之前，先問「對方的程式碼
  **實際上**是怎樣用這一欄的？」，而不是只看 schema 猜。

---

## 事故五：把「不適用」與「未排定」混為一談

發生日期：2026-08-20（第二輪之後）

### 現象

2027-10-10（當月第 2 個主日）的事奉框，聖餐襄禮顯示「（未排定）」。但那
一週**根本不設**這個崗位——聖餐只在每月第 1 個主日。同一個「（未排定）」
旁邊的講員，卻是崗位存在、只是等人手填。

### 根因

事奉框只問了一個問題：「這個 slot 有沒有人名？」沒有人名就一律顯示
「（未排定）」。但沒有人名其實有四種完全不同的原因，週報的處理也完全不同：

| 情況 | 應有的處理 |
|---|---|
| 這一週不設這個崗位 | **整行不出現** |
| 崗位外判給別的單位 | 顯示負責單位（例如「英語堂敬拜隊」） |
| 已排定 | 正常顯示姓名 |
| 崗位存在、等人填 | 顯示空白，並列入待填清單 |

把它們混成一種，代價是雙向的：幹事會被叫去填一個根本不存在的崗位，
而真正該填的欄位反而淹沒在雜訊裡。

### 修法

每個 slot 加一個 `state` 欄位，取值四選一：`ASSIGNED`／`NOT_APPLICABLE`／
`EXTERNAL`／`PENDING`，由 `resolveRosterSlotState_()` 判斷，次序**固定**是：

```
NOT_APPLICABLE → EXTERNAL → ASSIGNED → PENDING
```

**為什麼結構性不適用要排最先**：這一週「根本不設這個崗位」是關於**版面
結構**的判斷（整行不出現），其餘三種都是關於**那一格填什麼內容**。結構
先於內容——如果先判斷「有沒有人名」，一個沒有人名的聖餐襄禮就會被當成
`PENDING`。職事表的 `isStructuralNotApplicable_()` 也是同一個優先級，
兩邊一致才不會出現「職事表當它不存在、週報當它待填」。

另外：完全沒有派工紀錄的崗位也會補一個空白 slot，這樣才分得清「不適用」
與「等人填」——沒有 slot 就沒有東西可以判斷。

### 防止再發生的機制

- `tests/rostersnapshot.test.js` 的 Prompt3-state 系列：四種狀態各自的
  判斷條件，以及三組優先級（結構性勝過外判、外判勝過已排定、已排定勝過
  待填）。
- `tests/dutybox.test.js`：`NOT_APPLICABLE` 的崗位那一行要**完全消失**、
  整組不適用時合併組那一行也要消失、部分不適用時只略過該崗位。
- 本文件：提醒日後任何「這一格沒有值」的情況，先問「沒有值的**原因**有
  幾種？每一種在版面上的處理一樣嗎？」

---

## 事故六：系統自己組出來的文字被 Sheets 當成公式求值

發生日期：2026-08-20（第四輪之後）

### 現象

Diagnostics 工作表出現 7 行 `#ERROR!`。追查是「預覽本週週報資料」寫入的
「週報資料模型預覽」報告，區段標題 `'=== 基本資料 ==='` 這類字串被
`writeDiagnosticsReport_()` 用 `setValues()` 寫入後，Google Sheets 把它
當成公式（`=` 開頭）求值，直接壞掉。

### 根因

`writeSheet()`／`setValues()` 是程式呼叫，不是使用者在儲存格介面手動
打字——沒有「這一格是純文字格式」這道防線可以攔。`BulletinWeeks` 那類
「內容固定由人手填」的欄位有 `textFormatColumns` 保護（強制
`setNumberFormat('@')`），但 `Diagnostics`／`AuditLog` 這類**每次內容都
不一樣**的欄位沒辦法預先鎖死格式，而區段標題 `'=== 基本資料 ==='` 剛好
是以 `=` 開頭的字串，被 Sheets 的公式引擎接手。

`AuditLog` 的 `OLD_VALUE`／`NEW_VALUE` 有同一個風險，只是來源不同：這兩欄
的值直接來自使用者填在 `BulletinWeeks` 等工作表的內容（例如
`SERMON_TITLE` 如果剛好被填成 `=某段文字`），一路原樣傳到
`appendAuditLog_()` 再寫進 `AuditLog`。

### 修法

1. `src/SheetUtils.gs` 新增 `sanitizeCellText_(value)`：字串以
   `=`／`+`／`-`／`@` 其中一個字元開頭，就加一個前導半形單引號（Sheets
   官方認可的「強制當文字」寫法）；其餘型別與不需要跳脫的字串原樣回傳。
2. 兩個實際寫入路徑改用它：`writeDiagnosticsReport_()`（`REPORT_NAME`／
   `CONTENT`）與 `appendAuditLog_()`（全部欄位）。`SendLog` 本輪還沒有
   實際寫入邏輯，未來新增寫入函式時要一併套用。
3. `src/BulletinDiagnostics.gs` 的區段標題從 `'=== 基本資料 ==='` 改成
   `'【基本資料】'` 這種全形括號寫法——**就算下游有 `sanitizeCellText_()`
   保底，系統自己組字串時也不應該一開始就選一個會觸發保護機制的寫法**，
   保底跟「一開始就不要犯」要兩個都做。

### 防止再發生的機制

- `tests/sanitizecell.test.js`：純函式的 `=`／`+`／`-`／`@` 四種開頭與
  正常值／空值／`null`／數字／`Date` 的邊界案例，以及**由真正的寫入路徑
  （`writeDiagnosticsReport_()`／`appendAuditLog_()`）叫下去**、斷言工作表
  上的值真的有前導單引號，不是只有純函式本身正確、卻沒有在寫入路徑上
  生效。
- 本文件：提醒日後任何「系統自己組出來、要整批 `setValues()` 寫入」的
  文字（尤其是報告標題、狀態摘要這類容易湊巧用 `=`／`-` 開頭的字串），
  一律要經過 `sanitizeCellText_()`，不能只倚賴「使用者手動輸入時 Sheets
  自己會處理」的直覺——`setValues()` 走的是完全不同的路徑。

⚠️ **明確不採用的解法：把整欄設成 `textFormatColumns` 強制純文字格式。**
`Diagnostics`／`AuditLog` 這類表沒有固定要保護的欄——同一欄裡有些值是
日期（`GENERATED_AT`／`TIMESTAMP`）、有些是文字，鎖死整欄格式治標不治本，
而且下一個類似欄位還是會用同樣的方式出事。真正的修法是在**寫入的那一刻**
統一過濾，不管來源是哪一欄。

---

## 本專案要反覆自問的 bug class

寫任何一行程式碼之前，先自問這次會不會踩中以下任何一項：

1. **`.html` 註解裡不可以出現字面上的樣板標籤符號**——樣板引擎不理
   註解，字面上的樣板標籤在註解裡一樣會被引擎解析。
2. **缺失被當成正常值靜靜過。** 讀不到設定要明確拋錯或回一個獨立
   旗標，不可以退回空字串／空陣列然後繼續行落去。
3. **同一個狀態有兩個真相來源，只更新了其中一個。**
4. **從工作表讀出來的 Date／boolean 未經處理就用。** Google Sheets
   會把 `TRUE`／`FALSE` 正規化成 boolean、把日期形狀的字串正規化成
   Date 物件；讀取層必須有明確的型別正規化，而且要能偵測「本來想要
   字串卻拿到 Date」這類狀況。
5. **測試直接叫內部函式，沒有一個由真正入口叫下去。** Node 測試沒有
   真正的 Apps Script 執行環境，沒辦法完整取代「由 `onOpen()`／選單
   點擊觸發」這條真實路徑；真正的入口路徑最終仍然要由人手在試算表
   內操作一次確認。
6. **跨檔案的頂層初始化式，依賴 `.gs` 檔案的載入次序。**
   Apps Script 按檔名字母序執行每個檔案的頂層陳述式；任何頂層
   `var`／`const`／`let` 的賦值運算式，如果引用了另一個檔案宣告的
   識別碼，就是在賭「那個檔案剛好排在我前面」——賭錯的後果是整個
   專案載入失敗，而且是靜靜失敗、沒有任何使用者看得到的錯誤提示。
   凡是需要引用其他檔案常數／函式的初始化資料，一律包成函式延遲
   求值，讓它在被呼叫的那一刻才求值，而不是在檔案載入的那一刻。
7. **（本次新增）把別人系統的欄位當成自己的型別假設。** 讀外部系統
   的工作表時，只解析自己真正需要的欄，其餘一律放過；布林／列舉的
   語意要照抄對方的實作，不要自己另立一套；對方多出來的欄位不是
   錯誤。自己定義的 schema 才適用嚴格的「型別不符就拋錯」，別人的
   系統沒有這個資格。
8. **跨執行的快取套用在人手編輯的資料上。** 人手改完不生效，而且沒有
   任何錯誤訊息，只會表現成「設定好像沒有寫入」。單次執行內的記憶體
   快取沒有這個問題，可以放心用；跨執行、有存活時間的快取只適合套在
   「不會被人手直接改動、或者改動之後可以接受延遲生效」的資料上。
9. **（本次新增）用一個「對方根本不填」的欄位來查表。** 外部系統的
   schema 裡有某個欄位，不代表對方會填它、更不代表對方是用它來做關聯。
   要用外部系統的任何欄位做關聯之前，先去看**對方的程式碼實際上怎樣
   用這一欄**，不要只看欄位名稱猜。查不到會靜靜變成「沒有資料」，
   跟「真的沒有」分不出來。
10. **把「不適用」與「未填」混為一談。** 一格沒有值可以有
    很多種原因，而每一種在版面上的處理往往完全不同（整行不出現／顯示
    替代文字／留白待填）。混成一種的代價是雙向的：叫人去填根本不存在
    的東西，同時讓真正該填的淹沒在雜訊裡。寫任何「沒有值就顯示 X」的
    程式碼之前，先問「沒有值的原因有幾種？」
11. **（本次新增）系統自己組出來、要 `setValues()` 整批寫入的文字，
    沒有經過公式跳脫。** `setValues()` 不是使用者手動打字，沒有「這一格
    是純文字」這道防線；字串剛好以 `=`／`+`／`-`／`@` 開頭就會被 Sheets
    當成公式求值。凡是系統自己組字串（尤其是報告標題、狀態摘要）要寫
    進 `Diagnostics`／`AuditLog`／`SendLog` 這類表，一律要先經
    `sanitizeCellText_()`，而且組字串時也不要一開始就選會觸發這個問題
    的寫法（例如用 `'==='` 當分隔線）。
