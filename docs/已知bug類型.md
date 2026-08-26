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

## 事故七：同一個狀態在兩條路徑用了兩種表示法（第一次儲存永遠被誤判成 STALE）

發生日期：2026-08-20（第四輪之後）

### 現象

填寫介面載入正常（待填 22 項、警告 25 項、事奉名單與程序表預覽都有
內容），但撳「儲存」之後出現紅色橫幅：

> 這一週的資料在你編輯期間被其他人改過，請重新載入後再儲存。

而實際上**沒有任何人改過**，這一週從來未儲存過，「最後儲存時間」顯示
「（尚未儲存）」。更糟的是 Apps Script 的執行紀錄顯示 `apiSaveWeek`
狀態是「已完成」——因為錯誤被 `withApiResult_()` 接住並回傳
`{ok:false, error:{code:'STALE'}}`，對 Apps Script 而言那是一次**成功**
的執行，完全看不出裡面其實失敗了。

### 根因

「從未儲存」這個狀態有**兩種表示法**，載入與儲存兩條路徑各用一種：
`loadWeekForWebApp_()` 給前端的是 `weekRow.LAST_SAVED_AT || null`；
`saveWeekFromWebApp_()` 判斷樂觀鎖走的是另一套邏輯。兩條路徑「同一個
狀態」用了不同的值／不同的比較方式，稍有落差（型別不同、精度不同、
`null` 對上 `''`……）就會被判定不相符——於是**第一次儲存永遠失敗**，
而且訊息還誤導使用者以為「有人改過」，其實從來沒有人存過。

這正是本文件已知 bug class 第 3 項的具體案例：同一個狀態有兩個真相
來源，只是這次的「真相來源」不是兩份資料，而是**兩套各自獨立的正規化
邏輯**，看起來各自都合理，放在一起比較就對不上。

### 修法

1. `src/WebAppSave.gs` 新增唯一一個純函式
   `canonicalSaveToken_(value) -> string`：`null`／`undefined`／空字串／
   只有空白的字串一律回 `''`（代表「從未儲存」）；`Date` 物件、可以被
   `new Date()` 解析的字串、代表時間戳記的數字，一律格式化成
   `yyyy-MM-dd HH:mm:ss`；其餘字串回 `trim()` 後的原值。**載入
   （`loadWeekForWebApp_()`）與儲存（`checkOptimisticLock_()`／
   `buildSaveOperations_()`）兩條路徑都只准經過這一個函式**，不可以
   各自再發明一套「這算不算空」的判斷。
2. `apiLoadWeek()` 給前端的 `lastSavedAt`、`apiSaveWeek()` 回傳的
   `lastSavedAt`，統一都是這個函式正規化過的字串——前端只需要原樣存
   起來、儲存時原樣送回，不需要自己解析或轉換任何日期／時區。
3. 真正 STALE 時，錯誤訊息**同時包含兩個時間**（工作表上目前的最後
   儲存時間、你載入時的版本時間），不再只講一句「有人改過」卻不講是
   什麼時候。

### 防止再發生的機制

- `tests/savetoken.test.js`：`canonicalSaveToken_()` 的空值／`Date`／
  對應 ISO 字串／數字序列值／無法解析字串等邊界案例，以及**由真正入口
  `saveWeekFromWebApp_()` 叫下去**驗證首次儲存允許、token 相符允許、
  token 不符時訊息含兩個時間且完全沒有寫入。
- 本文件：提醒日後任何「同一個狀態，會經過不只一條程式路徑」的情況，
  先問「這兩條路徑，是不是真的呼叫同一個正規化函式？」而不是各自寫一套
  看起來合理、放在一起卻對不上的邏輯。

## 第 2 部分附帶的機制：把例外「看得見、留得低」

同一輪也順便修了「錯誤發生了但沒有人看得見」這個更廣的問題：
`withApiResult_()` 把例外接住變成 `{ok:false,...}` 之後，Apps Script
執行紀錄只看得到「這次呼叫完成」，完全看不出裡面其實是失敗的。新增
`ErrorLog` 工作表（`src/ErrorLog.gs`），伺服器端（`withApiResult_()`）、
前端（`window.onerror`／`window.onunhandledrejection` → 
`apiLogClientError()`）、選單（各個 `menuXxx_()` 的 catch 分支）三種
來源的例外統一記一筆，`SOURCE` 分別是 `SERVER`／`CLIENT`／`MENU`。
寫 `ErrorLog` 本身若失敗，`appendErrorLog_()` 自己吞掉例外、回傳
`false`，不會讓原本要回報的錯誤被蓋掉（`tests/errorlog.test.js` 有
專門測這一點）。`DETAIL` 欄位只准放堆疊頭幾行與不含個資的參數摘要，
**不可以存電郵或完整個人資料**。

同一輪還加了工作表結構版本檢查 `checkSheetSchema_()`
（`src/SchemaCheck.gs`）：本專案已經連續三次因為「push 了程式碼但沒有
撳『初始化工作表』」而浪費時間（新 Config 鍵未 seed、`BulletinWeeks`
缺 `LAST_SAVED_AT` 欄……）。這其實是同一類「看不見發生什麼」的問題的
另一種形式——結構落差不會馬上報錯，而是等某個功能因為讀不到欄位才
莫名其妙壞掉。現在 `doGet`（黃色橫幅）、選單「檢查工作表結構」、
`apiSaveWeek`（結構落後直接拒絕儲存，寧可拒絕也不要寫壞資料）三處
都會主動講出來。

---

## 事故八：成功訊息被緊接的重新載入清走

發生日期：2026-08-20（第四b輪之後）

### 現象

三個現象一起出現：

1. 儲存成功之後，綠色訊息「已儲存，更新了 N 個欄位。」**完全看不見**。
2. 不改任何欄位再儲存，藍色訊息「沒有偵測到任何改動，工作表沒有
   變更。」同樣看不見。
3. 載入需時頗長，期間畫面沒有任何指示，看起來像當機；載入或儲存進行
   中，「儲存」按鈕仍然可以再撳。

伺服器端一切正常（`AuditLog` 逐格記錄正確、`ErrorLog` 零筆、樂觀鎖
已修好）——純粹是前端回饋的問題。

### 根因

```js
function onSaveSuccess(resp) {
  ...
  showMessage('success', '已儲存，更新了 N 個欄位。');
  loadWeek(state.isoDate);          // ← 這一句
}

function loadWeek(isoDate) {
  hideMessage();                    // ← 第一行就把剛剛顯示的訊息清走
  ...
}
```

`showMessage()` 顯示訊息之後，緊接著呼叫的 `loadWeek()` 開頭第一行就是
`hideMessage()`——訊息顯示之後幾十毫秒就被自己清掉，使用者的視線根本
來不及從按鈕移到訊息橫幅，等於永遠看不見。**凡是「顯示訊息之後立即
觸發另一個會清訊息的動作」都會踩中同一個坑**，不限於這一個呼叫點。

另外兩個現象（沒有忙碌指示、按鈕可以連撳）根因是同一件事的另一面：
前端完全沒有一個統一的「目前是不是在等伺服器回應」狀態，每個
`google.script.run` 呼叫各自處理自己的忙碌／停用邏輯（甚至部分呼叫
完全沒有），沒有一個地方統一決定「現在能不能撳」。

### 修法

1. `loadWeek(isoDate, options)` 加 `options.keepMessage`：使用者主動
   切換主日不傳（照舊清訊息），`onSaveSuccess()` 顯示完訊息、要重新
   整理畫面時傳 `{ keepMessage: true }`。成功／資訊訊息額外訂一個
   **下限**（`MESSAGE_MIN_VISIBLE_MS`，5 秒）才淡出，即使某個呼叫點
   忘記傳 `keepMessage`，至少訊息還撐得住一段時間讓人看到。
2. 前端 `state` 加計數器 `state.inFlight`（**不是 boolean**，因為同一
   時間可能有一個以上的請求在跑）與唯一一個顯示函式
   `applyBusyState()`：`inFlight > 0` 時顯示頂部忙碌指示列、停用主日
   下拉／「儲存」／「重新讀取職事表」、內容區加半透明遮罩。每個
   `google.script.run` 呼叫前 `beginRequest()`，成功／失敗處理函式
   **最前面**呼叫 `endRequest()`（避免中途 `return` 漏減）。
3. 即時預覽（`apiPreviewProgram`）用另一個獨立計數器
   `previewInFlight`，完全不進入上面的忙碌邏輯——預覽每次打字都會
   觸發，停用整個介面會令人打不了字。
4. 「儲存」防止重複提交分兩層：按鈕 `disabled`（視覺層，跟著
   `applyBusyState()` 走）＋ `saveWeek()` 開頭 `if (state.inFlight > 0)
   return;`（邏輯層，防鍵盤 Enter 或瀏覽器擴充功能繞過 `disabled`）。
5. 訊息文案移到 `.gs`（`buildSaveResultMessage_()`／
   `buildRosterReloadMessage_()`）——前端沒有 Node 測試，文案分支放在
   這裡才測得到。

### 防止再發生的機制

- `tests/webappmessages.test.js`：兩個文案函式的邊界案例（`0`／`null`／
  `undefined` 當作 0 處理、有無改動用不同文案），以及由真正入口
  `apiSaveWeek()` 叫下去確認回傳物件含 `message`。
- 本文件：提醒日後任何「顯示一則訊息之後，緊接著呼叫另一個會刷新畫面
  的函式」都要先問「那個函式會不會把我剛顯示的東西清掉？」，而且忙碌
  ／停用狀態要有**單一**顯示函式，不要讓每個呼叫點各自決定「現在能不
  能撳」。

---

## 事故九：Word 會把一個佔位符拆成多個 `<w:r>`

發生日期：2026-08-21（第七輪，Word 範本渲染引擎）

### 現象

（這一則是**預防性**記錄——在寫渲染引擎的當下就先擋住，不是事後補記。
`tests/docxtemplate.test.js` 的第 1 個測試把整個現象重現了一次。）

範本上明明打住 `{{SERMON_TITLE}}`，渲染之後那一格**原樣印住
`{{SERMON_TITLE}}`**，沒有被換成講題。系統不會拋錯、不會有 warning，
`AuditLog` 一切正常——要到週報印出來、有人肉眼看到，才會發現。

### 根因

`.docx` 內的一段文字不是一整串存的，是切成一個個 `<w:r>`（run）。
Word 會因為**拼寫檢查、語言標記、樣式殘留**在任意位置切開，所以
`{{SERMON_TITLE}}` 很可能被存成：

```xml
<w:r><w:t>{{</w:t></w:r>
<w:proofErr w:type="spellStart"/>
<w:r><w:t>SERMON</w:t></w:r>
<w:r><w:t>_TITLE}}</w:t></w:r>
```

在 XML 字串上做 `replace('{{SERMON_TITLE}}', ...)` 永遠配不到——那串字
**根本不曾以完整形態出現過**。

這個 bug 特別惡劣的地方在於：它**只在某些佔位符上發生**。同一份範本
裡，沒有被拼寫檢查標記過的佔位符替換得好好的，被標記過的就原樣留下，
看起來像「範本某幾格打錯字」，會把人引去查完全錯的方向。

### 修法

替換之前**一定**先跑 `mergeRunsInParagraphs_()`（`src/DocxTemplate.gs`）：
在每個 `<w:p>` 內，把**格式完全相同**（`<w:rPr>` 原文一字不差）的相鄰
`<w:r>` 合併成一個。

幾個刻意的保守決定：

- 只合併「只含 `<w:rPr>` 與 `<w:t>`」的 run。含 `<w:drawing>`（圖片）、
  `<w:tab/>`、`<w:br/>`、`<w:fldChar>` 的一律不合併——合併會丟失內容。
- 兩個 run 之間只准夾空白與 `<w:proofErr>`／`<w:noProof>`。這兩個純粹是
  拼寫檢查的中繼資料，丟掉安全，而且正正是它們夾在中間造成切斷。其餘
  任何東西（書籤、註解錨點、欄位代碼）一律**阻擋合併**。
- 合併結果一律寫成 `xml:space="preserve"`，否則「祈禱會 眾坐」會變成
  「祈禱會眾坐」——原本分開的 run 各自有沒有這個屬性不一定，串起來之後
  空白的位置變了。

### 合併不了的情況要講出來

中間真的夾了書籤、或者兩半的字型真的不同時，合併不了。**這時絕對不可
以靜靜略過**——`findBrokenPlaceholders_()` 會逐段掃描，把「`{{` 與 `}}`
落在不同 `<w:t>`」「有頭無尾」「有尾無頭」三種情況全部報成 warning，
選單的產生報告與「檢查範本佔位符」都會列出來。

實務上的修法是叫 Ivan 在 Word 把那個佔位符**整段刪掉重新打一次**
（見 docs/Word範本製作指引.md）。

### 留低咗啲乜

- `mergeRunsInParagraphs_()`：合併，替換流程的**第一步，不可以省略**。
- `findBrokenPlaceholders_()`：合併不到的要報出來，不可以靜靜略過。
- 選單「檢查範本佔位符」：範本到手之後第一件要做的事，會直接列出
  「範本用到但系統不提供」「系統提供但範本沒有用到」「疑似被切斷」
  三張清單。
- `tests/docxtemplate.test.js` 第 1 個測試：先斷言「未合併之前一定替換
  不到」，再斷言合併之後替換得到——把現象本身鎖住，日後有人「順手簡化」
  掉合併那一步，測試會立刻紅。

---

## 事故十：多趟替換之下，先填進去的值會被後面那一趟再替換一次

發生日期：2026-08-21（第七輪，寫測試時發現）

### 現象

某一則家事報告的內容如果人手打住 `{{SERMON_TITLE}}` 這種字樣（純粹是
使用者想印出兩個大括號），渲染之後那段字**會被換成當週的講題**。
使用者填的內容被系統無聲改寫。

### 根因

整個渲染流程是**多趟**的，而且次序是固定的（見 `renderDocumentXml_()`）：
先展開重複列、最後才替換單值。清單資料是在「展開」那一趟填進 XML 的，
所以它會再經過後面「替換單值」那一趟——填進去的值於是被當成範本的一
部分再掃描一次。

單值替換本身沒有這個問題（它是單次 `replace()` 加 callback，值填進去
之後不會再被掃），但**跨趟**就會。

### 修法

`toWordText_()`（全部值injection 的唯一出口）把值裡面的 `{` 與 `}` 換成
數值字元參照 `&#123;`／`&#125;`。Word 照樣顯示 `{` 與 `}`，但後面幾趟
掃描再也認不出它是佔位符。

原則：**值一律只當資料，永不當程式碼。**

### 留低咗啲乜

- `toWordText_()` 內的大括號中和，以及它的 docstring 說明為什麼。
- `tests/docxtemplate.test.js` 的「值本身含 `{{ }}` 不會被二次替換」與
  「清單資料的值含 `{{ }}` 同樣不會被二次替換」兩個測試。

---

## 事故十一：雙向同步用兩方比較而不是三方比較

發生日期：2026-08-21（第八輪，季度填寫表）

### 現象

（預防性記錄——寫的時候就先擋住。）

季度填寫表 `Fill_<QuarterID>` 與 `BulletinWeeks` 兩邊都可以編輯。如果用
「格子表現值 vs `BulletinWeeks` 現值」判斷有沒有衝突，會同時出兩種錯：

1. **每一個正常的改動都會被報成衝突。** 幹事在格子表填了一個講題，兩邊
   現值當然不同——但那根本不是衝突，是「只有一邊改過」，應該直接寫回去。
   衝突清單於是變成純噪音，人很快就不再看。
2. **分不出應該寫向哪一邊。** 兩邊不同時，到底是格子表改過（要 `PUSH`）
   還是系統改過（要 `PULL`）？兩方比較答不到這個問題，只能靠猜——猜錯
   就會把人剛填的東西蓋掉。

### 根因

「兩邊現值不同」這件事**本身沒有資訊量**。要判斷的是「**自從上次一致
之後，是哪一邊變過**」，那需要第三個值：**上次一致時的值**。

### 修法

新增 `FillSnapshot` 工作表存快照，逐格做**三方**比較：

| 格子表 vs 快照 | 系統 vs 快照 | 結果 | 處理 |
|---|---|---|---|
| 相同 | 相同 | `SAME` | 不做任何事 |
| **不同** | 相同 | `PUSH` | 寫回 `BulletinWeeks` |
| 相同 | **不同** | `PULL` | 刷新格子表 |
| **不同** | **不同** | `CONFLICT` | 兩個值都列出來由人選，**不自動蓋任何一邊** |

⚠️ 這跟第六輪 `src/RosterDiff.gs` 用 `ROSTER_VALUE_AT_OVERRIDE`（覆寫當時
記下的職事表值）而不是「職事表現值 vs 週報現值」判斷衝突，是**完全同一個
道理**。兩處的 docstring 互相交叉引用。

### 一個必須留的例外

**快照缺失**（第一次同步、或者程式新加了一欄）時沒有基準可以比，這時一律
當成「只有一邊改過」而**不是**衝突——第一次建立格子表時每一格都沒有快照，
全部報成衝突的話這個功能等於不能用。

### 留低咗啲乜

- `compareFillCell_()`（`src/FillSync.gs`）：三方比較的唯一實作。
- `tests/fillgrid.test.js` 的測試 `1e`：同樣是「兩邊現值不同」，靠快照
  才分得出 `PUSH`／`PULL`／`CONFLICT` 三種結果——把「兩方比較不可能做對」
  這件事直接鎖住。

---

## 事故十二：更新快照時只動一邊，把另一邊的舊值變成「假的改動」

發生日期：2026-08-21（第八輪，寫測試時發現）

### 現象

填寫介面儲存一個講題之後，跑一次同步，那個講題**被改回舊值**——使用者
剛剛存好的內容無聲被蓋掉。

### 根因

`FillSnapshot` 的語意是**「兩邊上一次一致時的值」**。

當時的做法是：填寫介面儲存之後，把快照推到系統的新值。但**格子表仍然
停在舊值**。於是下一次三方比對看到：

- 格子表(舊) ≠ 快照(新) ⇒ 判定「格子表改過」
- 系統(新) ＝ 快照(新) ⇒ 判定「系統無改過」
- 結論：`PUSH`，把格子表那個**根本沒有人改過的舊值**寫回系統

一個「令兩邊同步」的動作，反而把資料推向錯的方向。

### 修法

更新快照的時候，**同時把新值寫進格子表**，令兩邊真的重新一致——
快照的語意才成立。

而如果格子表那一格**本身有未同步的改動**（格子表現值 ≠ 快照），就
**一格都不動**：那是真正的「兩邊都改過」，要留給同步報成衝突由人決定，
不可以在儲存的時候靜靜蓋掉幹事在格子表打的字。

### 留低咗啲乜

- `refreshFillSnapshotAfterSave_()`（`src/WebAppSave.gs`）的實作與 docstring。
- `tests/fillgrid.test.js` 的 `9b-2`（反向鎖：儲存之後同步**不可以**把舊值
  推回去）與 `9b-3`（格子表有未同步的改動時，儲存不可以蓋掉它）。

---

## 事故十三：JSON 序列化把 Date 變成字串，還原時一格都對不上

發生日期：2026-08-21（第八輪，寫測試時發現）

### 現象

`FillBackup` 備份看起來一切正常（有記錄、有行數、JSON 完整），但還原時
回報「改動 0 格」——**一份還原不到的備份**。

而且它不會拋錯、不會有警告，只會安靜地什麼都不做。人會以為「內容本來就
一樣」，直到真的需要還原那一刻才發現備份是廢的。

### 根因

`JSON.stringify()` 把 `Date` 變成 ISO 日期時間字串
（`2027-11-06T11:00:00.000Z`——注意時區偏移已經令日期跳到前一日），
`JSON.parse()` 回來只是一個字串、不再是 `Date`。

還原時用那個字串去對 `SERVICE_DATE`，**一個主日都對不上**，於是
「沒有任何一格需要還原」。

### 修法

序列化之前先把 `Date` 欄位轉成 `yyyy-MM-dd` 字串
（`normalizeRowsForBackup_()`）。這樣 JSON 內容穩定、人看得懂、而且
round-trip 一致。

### 順帶修好的一件事

備份編號是 `<季度>-<到秒的時間戳記>`，**同一秒內兩次備份會撞名**。
這不是理論問題：使用者撳「立即備份本季」之後緊接着撳「還原到某個備份」，
還原前的安全備份就有機會落在同一秒。撞名的後果是
`groupFillBackups_()` 把兩份完全不同的 JSON 當成同一個備份的兩個分段
串在一起，串出來不是合法 JSON——**兩份備份同時報廢**。
`buildBackupId_()` 現在會避開已經存在的編號。

### 留低咗啲乜

- `normalizeRowsForBackup_()` 與 `buildBackupId_()` 的 `existingIds` 參數。
- `tests/fillbackup.test.js` 的 `3b`（還原之後用安全備份再還原回去）——
  那個測試同時踩中兩個 bug，兩個都修好才會綠。

---

## 事故十四：「處理填寫表衝突」預選了「暫不處理」，撳確定之後外表跟壞掉一樣

發生日期：2026-08-21（prompt8b，Ivan 實測發現）

### 現象

Ivan 依「處理填寫表衝突」的流程操作之後，`BulletinWeeks` 與
`Fill_2027T4` 兩邊的值完全沒有改變：

- `AuditLog` **完全沒有** `FILL_CONFLICT_RESOLVE` 這個動作的任何一筆記錄
- `ErrorLog` 是空的（沒有任何伺服器錯誤）
- `Diagnostics` 的「季度填寫表同步」報告顯示衝突仍然是 1 格

沒有錯誤、沒有記錄、沒有變化——**外表看起來就跟系統壞了一模一樣**。

### 根因

對話框每一行的「暫不處理」是預選值（`checked`）。使用者以為自己選了
別的選項，其實根本沒有動到任何一個 radio，撳「確定」送出的三個選擇
仍然是預設的 `SKIP`。而系統對 `SKIP` 的定義是「完全不動、也不留記錄」，
於是這次操作**看起來跟什麼都沒做完全一樣**，跟系統真的壞掉分不出來。

**這是介面設計的問題，不是使用者的問題。** 一個「撳完確定之後毫無
反應、而且不留下任何線索」的畫面，本身就是 bug。

### 修法

1. 三個選項一律不預選；「確定」按鈕預設 `disabled`，每一行都選過才
   能撳。
2. 上方加即時摘要（「將套用：填寫表 N 格　系統 M 格　暫不處理 K 格」）
   與「尚有 N 行未選擇」提示。
3. 成功之後**不自動關閉**，把結果明確顯示出來，全部選 SKIP 時要有
   專門的訊息說明「一格都沒有改動」。
4. `resolveFillConflicts_()` 改為**無論結果如何都寫一筆
   `FILL_CONFLICT_RESOLVE_RUN` 總結記錄**，內含 `unmatched`（送來的
   decision 對不上任何目前衝突的數目）——日後再遇到「撳了但沒反應」，
   看 `unmatched` 就知道是前後端鍵值對不上，還是使用者真的全部選了
   暫不處理。

### 留低咗啲乜

- `src/ui/FillConflict.html` 的即時摘要／未選擇提示邏輯。
- `resolveFillConflicts_()`（`src/FillMenu.gs`）的 `unmatched` 計數與
  無條件總結記錄。
- 唯讀欄還原的通知方式順帶從永久儲存格註解改成 5 秒浮動 `toast()`——
  舊寫法就算把值改回正確，註解仍然永久留在格上，累積成一堆垃圾。

---

## 事故十五：已經 JSON 編碼的值用了會轉義的樣板標籤，季度 ID 連引號一起變成資料

發生日期：2026-08-21（prompt8b 修完事故十四之後，Ivan 再次實測發現）

### 現象

修完事故十四（不再預選「暫不處理」）之後，Ivan 重新測試「處理填寫表
衝突」：三個選項都明確選過、摘要正確顯示、撳「確定」——**還是一格都
沒有改動**。這一次 `AuditLog` 有留下記錄，但內容很奇怪：

```
FILL_CONFLICT_RESOLVE_RUN
{"decisionsReceived":1,"matchedConflicts":0,"appliedGrid":0,
 "appliedSystem":0,"skipped":0,"unmatched":1}
```

同一筆記錄的 `SHEET_NAME` 是 `Fill_"2027T4"`、`ROW_KEY` 是 `"2027T4"`——
季度 ID **連兩側的雙引號都變成了字串內容的一部分**。

### 根因

`ui/FillConflict.html` 要把伺服器端的 `quarterId` 變數轉成一段可以直接
當 JavaScript 字面值使用的常數，所以用了 `JSON.stringify(quarterId)`
先編碼好（結果是 `"2027T4"` 這個字串，含兩側雙引號）。

但輸出到頁面時，用的是 HtmlService **會轉義**的那一種輸出標籤——這種
標籤會把值當成要顯示在畫面上的普通文字，再做一次 HTML 轉義。已經是
合法 JS 字面值的 `"2027T4"` 被當成普通文字轉義之後，雙引號本身變成
被跳脫的一般字元，於是瀏覽器裡執行的 `QUARTER_ID` 變數其實是
`"2027T4"`（連引號一起的 9 個字元），不是 `2027T4`（4 個字元）。

之後這個帶引號的字串一路傳到伺服器，`fillGridSheetName_()` 組出
`Fill_"2027T4"`，`fillSnapshotKey_()` 用它組出來的鍵當然對不上任何一個
真正的衝突——**送出的每一個選擇都變成 `unmatched`**。這正是事故十四
想要避免的那種「撳了確定但毫無反應」，只是這次是由完全不同的根因
造成，而且比事故十四更隱蔽：介面本身的行為（選過、摘要正確、送出）
全部正常，問題出在看不到的資料編碼層。

同一個檔案裡的 `conflictsJson`（同樣是伺服器端已經 `JSON.stringify()`
過的值）用的是**不轉義**的輸出標籤，所以沒有這個問題——兩種標籤混用
在同一個檔案裡，讓這個落差更容易被忽略。

### 修法

1. 把 `QUARTER_ID` 那一行改用**不轉義**的輸出標籤，與 `conflictsJson`
   一致；並在檔頭註解寫明兩種輸出標籤的分別（用文字描述、不要在
   `.html` 註解裡寫出字面上的樣板標籤符號——見 bug class 第 1 項）。
2. 加第二層防線：`normalizeQuarterId_()`（`src/FillGrid.gs`）在伺服器端
   把收到的季度 ID 剝掉頭尾空白與成對引號，並驗證格式（四位年份 + T +
   一位數字），不合格式就明確拋錯——不管前端是不是又用錯了輸出標籤，
   伺服器都不會把一個帶雜訊的值當成乾淨資料繼續往下傳。
3. `resolveFillConflicts_()` 加一個語意檢查：送來的選擇**全部**對不上
   目前的衝突（`decisionsReceived > 0` 且 `matchedConflicts === 0`）時，
   直接拋錯（`code: 'NO_MATCHING_CONFLICT'`）並且不寫任何東西——這種
   情況已經不是「使用者的選擇」，是系統性的鍵值不符，繼續假裝正常
   完成、只在 `AuditLog` 留一筆看起來像「全部跳過」的記錄，一樣會讓人
   誤判成使用者自己選錯。

### 留低咗啲乜

- `src/ui/FillConflict.html`：`QUARTER_ID` 改用不轉義標籤；檔頭新增
  兩種輸出標籤的文字說明。
- `src/FillGrid.gs`：`normalizeQuarterId_()`。
- `src/FillMenu.gs`：`apiResolveFillConflicts()` 呼叫
  `normalizeQuarterId_()`；`resolveFillConflicts_()` 的
  `NO_MATCHING_CONFLICT` 拋錯邏輯。
- 前端成功訊息不可以只憑「`appliedGrid`／`appliedSystem` 是不是都是
  0」去猜是不是「使用者全部選了暫不處理」——那個條件在
  `unmatched > 0`、`skipped === 0` 的情況下一樣成立，會顯示一句
  跟事實不符的訊息。改成只有 `skipped > 0` 才可以這樣講。

---

## 事故十六：刪走表格儲存格內唯一的段落，Word 判定檔案損毀要求修復

發生日期：2026-08-21（prompt9，Ivan 造範本時實測發現）

### 現象

Ivan 用 Word 做範本時，把一個表格儲存格內原本的內容整段刪掉、只留
一個 `{{#EACHP:ANNOUNCEMENT}}` 標記段落（打算讓系統依清單長度展開）。
清單為空時，如果系統把那個段落**整段刪除**，那個表格儲存格就會變成
**零個段落**。開啟產生出來的 `.docx`，Word 直接判定「檔案已損毀」，
要求修復才能開啟。

### 根因

OOXML 規定每個 `<w:tc>`（表格儲存格）**至少要有一個 `<w:p>`**（段落）
——這是格式本身的硬性結構規則，不是 Word 的行為怪癖。`expandEachRows_()`
（列層展開）刪整列的時候不會踩到這個問題，因為連儲存格本身都一起
被刪走了；但段落層的展開如果比照列層「清單為空就整段刪除」，一旦那個
段落剛好是它所在儲存格的唯一內容，就會把儲存格留在「零段落」的非法
狀態。

### 修法

`expandEachParagraphs_()`（`src/DocxTemplate.gs`）在刪除段落之前，先用
`isSoleParagraphInTableCell_()` 判斷這個段落是不是它所在 `<w:tc>` 的
唯一段落：

- **是**：不刪除，改為保留段落結構（格式、`<w:rPr>` 全部不動），只
  清空 `<w:t>` 裡面的文字（`clearParagraphTextKeepingStructure_()`）。
- **不是**（不在表格內，或表格儲存格內還有其他段落）：照舊整段刪除。

### 留低咗啲乜

- `tests/eachparagraph.test.js` 的 `2a`／`2c` 兩個測試專門鎖住這個
  規則——`2a` 驗證唯一段落被清空而不是刪除，`2c` 驗證「儲存格有其他
  段落時，範本段落照樣可以被刪除」不會被誤判成唯一段落。
- 這是**規約層級**的教訓，不只是這一個函式的事：**任何要在 OOXML
  結構裡「整個刪除」某個元素的程式碼，動手之前都要先確認這個元素
  所屬的父層結構有沒有「至少要有一個子元素」這類硬性規定**——`<w:tc>`
  要有 `<w:p>` 是其中一條，日後如果要刪 `<w:tbl>`（表格本身在某些
  容器內）、`<w:sdt>` 之類的元素，同樣要先查清楚有沒有類似的下限。

---

## 事故十七：第一次用到新的 Google 服務，既有授權令牌不會自動擴大，`appsscript.json` 沒列 `oauthScopes` 就不會強制重新授權

發生日期：2026-08-21（prompt9 之後，Ivan 第一次撳「檢查範本佔位符」
實測發現）

### 現象

prompt9 那一輪第一次讓程式碼用到 `DriveApp`（讀 Word 範本、寫輸出
檔案）。Ivan 撳「檢查範本佔位符」，對話框沒有正常顯示結果，而是報錯：

```
You do not have permission to call DriveApp.getFileById.
Required permissions: (https://www.googleapis.com/auth/drive.readonly ||
https://www.googleapis.com/auth/drive)
```

### 根因

Apps Script 的授權令牌**只在使用者當初授權那一刻**問過「這個腳本要用
到以下服務，你同意嗎？」，那次同意涵蓋的是**當時程式碼實際會用到的
服務**。之後新增的程式碼如果第一次用到一個新服務，既有令牌不會自動
擴大——這件事本身沒有問題，是設計如此；問題是**`src/appsscript.json`
當時沒有明確列出 `oauthScopes`**。沒有明確列出時，Apps Script 用
「自動掃描程式碼推斷範圍」這條路徑，而**既有的授權狀態不會因為推斷出
的範圍變大就主動要求重新授權**——使用者完全沒有機會被提示「這次操作
需要新的權限，請重新同意」，直到真的呼叫到那個服務才在執行期間爆出
一個看起來像伺服器錯誤、其實是授權問題的訊息。

### 修法

1. `src/appsscript.json` 明確列出 `oauthScopes`（試算表、雲端硬碟、
   選單對話框、觸發器、寄信、使用者電郵六項，逐項注意只列真正用到的，
   不要多列）——明確列出範圍之後，範圍改變時 Apps Script 才會在下次
   執行要求重新授權。
2. 加共用函式 `enrichAuthError_()`（`src/ErrorLog.gs`）：偵測錯誤訊息
   含 `permission`／`authorization`／`Required permissions` 字樣，
   在訊息後面加一句操作指引，讓使用者一看就知道要去哪裡重新授權，
   不會誤以為是程式壞了。這個函式取代了全部**選單處理函式**與
   `withApiResult_()` 原本各自 `String(err && err.message ? ... )`
   的寫法，37 處呼叫全部改用同一個函式——**同一個狀態的正規化邏輯只
   准存在一份**（見反覆自問清單第 12 項），不然日後只改了其中幾處，
   訊息會不一致。
3. 新增選單「檢查授權範圍」：主動逐一試探性呼叫全部用得到的服務，
   讓使用者不用等到操作到一半才發現授權有問題。

### 留低咗啲乜

- `src/appsscript.json` 的 `oauthScopes`。
- `src/ErrorLog.gs` 的 `enrichAuthError_()`、`AUTH_ERROR_KEYWORDS_`。
- `src/SelfCheck.gs` 的 `authorizationScopeProbes_()`／
  `checkAuthorizationScopes_()`／`menuCheckAuthorizationScopes_()`。
- `src/DocxIo.gs` 的 `probeDriveAccess_()`——⚠️ 函式名稱刻意不叫
  `probeDriveAppAccess_`：那個名稱裡剛好完整包含字面上的
  `DriveApp` 四個字，會被 `tools/lint-readonly-roster.js` 的規則 3
  （「DriveApp 只准出現在 DocxIo.gs」）誤判成違規——那條規則是單純
  字串比對，不分辨那是服務呼叫還是識別碼的一部分。**任何要在
  `DocxIo.gs` 以外的檔案提到／呼叫 Drive 相關能力時，函式名稱與字串
  標籤都要避開連續出現「DriveApp」這個字面組合**，這一輪就是在
  `tests/selfcheck.test.js` 寫測試的過程中先被 lint 擋下來才發現的。
- `tests/errorlog.test.js`：`enrichAuthError_()` 的測試。
- `tests/selfcheck.test.js`：`checkAuthorizationScopes_()` 的測試，
  連帶在 `tests/helpers/fakeDrive.js` 補了 `getRootFolder()`（含
  `rootAccessError` 選項模擬授權失敗）、`tests/helpers/fillEnv.js`
  補了假試算表的 `getName()`。

---

## 事故十八：`Utilities.unzip()`／`Utilities.zip()` 只認內容類型，跟檔案實際格式無關

發生日期：2026-08-21（事故十七解決之後，Ivan 緊接著撳「檢查範本佔位符」
再次實測發現）

### 現象

事故十七的授權範圍問題解決之後，Ivan 再撳一次「檢查範本佔位符」，
換成另一個錯誤：

```
無法解壓 Word 範本檔：Invalid argument: ContentType. Should be of type:
application/zip.
```

範本檔案本身完全正常，Config 的檔案 ID 也是對的。

### 根因

`.docx` 骨子裡就是一個 zip 檔（OOXML 格式），但 **`Utilities.unzip()`
不會自己去判斷「這個 blob 的位元組看起來像不像 zip」，只死板地檢查
blob 回報的內容類型字串是不是剛好等於 `application/zip`**。而
`DriveApp.getFileById(id).getBlob()` 讀出來的內容類型是 Word 自己的
MIME（`application/vnd.openxmlformats-officedocument.wordprocessingml.document`），
不是 `application/zip`——即使檔案的真實位元組內容百分之百是合法的 zip，
`Utilities.unzip()` 照樣直接拒絕，連嘗試解都不嘗試。

`Utilities.zip()` 也有鏡像的另一半：壓縮完成之後，回傳 blob 的內容
類型固定是 `application/zip`，不會自動猜回「這其實是一份 `.docx`」。
如果不手動改回 Word 的 MIME，存到雲端硬碟的檔案會被系統當成
`.zip`，Word 完全打不開。

一來一回，兩邊都要人手介入一次——`Utilities.unzip()`／`Utilities.zip()`
把「內容類型」跟「檔案實際格式」當成兩件完全獨立的事，呼叫方要自己
確保兩者對得上。

### 修法

1. `unzipDocx_()`（`src/DocxIo.gs`）在呼叫 `Utilities.unzip()` 之前，
   先用 `blob.copyBlob()` 複製一份，把**複製品**的內容類型改成
   `application/zip` 再解壓——刻意用複製品而不是直接改原本傳進來的
   `blob`，因為那個物件是呼叫端手上的，悄悄改掉它的內容類型會是一個
   隱藏的副作用（例如同一個 blob 之後又被拿去做別的事）。
2. `zipDocx_()` 本來就已經在 `Utilities.zip()` 之後把內容類型改回
   `DOCX_MIME_TYPE_` 並確保檔名——這是事故十五那一輪順手做的
   MIME 檢查連帶補上的，這次只是把 docstring 寫得更明確，講清楚
   「為什麼一定要做」這一步，不是單純「順手」。

### 留低咗啲乜

- `src/DocxIo.gs`：`unzipDocx_()` 的 `blob.copyBlob().setContentType(...)`。
- `tests/helpers/fakeDrive.js`：`makeFakeBlob()` 補了 `copyBlob()`；
  假的 `Utilities.unzip()` 改成**真的檢查**內容類型是不是
  `application/zip`（原本只檢查 `blob.__entries` 存不存在，測不出這個
  事故），才擋得住「忘記轉換內容類型」這個類別的回歸。
- `tests/docxio.test.js` 的 `3e`–`3i` 五個測試，專門鎖住這一來一回的
  轉換。
- 這是繼事故十七之後，同一次「範本要讀寫 Drive」功能第二次因為
  **API 對輸入格式的隱性要求**（前一次是授權範圍，這一次是內容類型
  字串）而在真實環境撞到、Node 測試卻沒有事先攔住的例子——兩次的
  假替身都太寬鬆（授權一律通過、內容類型不檢查），跟真實服務的
  嚴格程度不對稱。**幫外部服務寫假替身時，寧可讓假替身比真實服務
  更嚴格一點**，才不會讓「假替身通過、真環境失敗」這種情況一犯再犯。

---

## 事故十九：`findPlaceholders_` 認得 `#EACH:` 前綴，但認不出 `#EACHP:`——多字元前綴要照字串長度由長到短比對

發生日期：2026-08-21（事故十八解決之後，Ivan 撳「檢查範本佔位符」實測
發現）

### 現象

Ivan 用真實範本跑「檢查範本佔位符」，報告講「範本用到但系統不提供」
有 5 個，其中兩個是 `#EACHP:ANNOUNCEMENT`、`#EACHP:PRAYER`——但這兩個
清單系統明明有提供（`supportedListPlaceholders_()` 有列出
`ANNOUNCEMENT`／`PRAYER`），範本也確實是照 prompt9 新增的段落層清單
語法 `{{#EACHP:LIST}}` 寫的，理論上應該對得上才對。

### 根因

`findPlaceholders_()`（`src/DocxTemplate.gs`）原本判斷前綴的寫法是：

```js
if (body.indexOf('#EACH:') === 0) { type = 'EACH'; name = body.slice(6); }
else if (body.indexOf('#IF:') === 0) { ... }
```

`'#EACHP:ANNOUNCEMENT'.indexOf('#EACH:')` 的結果是 `-1`，不是 `0`——
因為字串比對是逐字元對齊，`#EACH:` 第 6 個字元是 `:`，而
`#EACHP:ANNOUNCEMENT` 第 6 個字元是 `P`，兩者對不上，`indexOf` 找不到
這個子字串出現在開頭。既然 `#EACH:` 這個分支不成立，`#IF:`／`#IFP:`
兩個分支當然也不成立（字串裡根本沒有 `#IF`），程式碼於是落到最後的
預設值：`type = 'SIMPLE'`，`name` 維持成整段字串（含 `#EACHP:` 這個
字面前綴）。

這個偽造出來的「單值佔位符」名稱是 `'#EACHP:ANNOUNCEMENT'`，拿去跟
`supportedValuePlaceholderNames_()` 對——那份清單裡當然不會有任何
帶 `#` 開頭的名字，於是誤報成「範本用到但系統不提供」。真正該對的
`usedLists`（清單標記）完全沒被算進去，`ANNOUNCEMENT`／`PRAYER` 這兩個
清單反而在錯誤的欄位（單值）裡消失。

`#IFP:`／`#IF:` 兩者也是同樣的「短前綴先比對、長前綴永遠比對不到」
陷阱，只是範本剛好沒用到 `#IFP:` 段落條件標記，所以沒有一併觸發。

### 修法

`findPlaceholders_()` 改成先比對**較長、較特定**的前綴，比對不到才
退回比對較短的前綴：

```js
if (body.indexOf('#EACHP:') === 0) { type = 'EACHP'; name = body.slice(7); }
else if (body.indexOf('#EACH:') === 0) { type = 'EACH'; name = body.slice(6); }
else if (body.indexOf('#IFP:') === 0) { type = 'IFP'; name = body.slice(5); }
else if (body.indexOf('#IF:') === 0) { type = 'IF'; name = body.slice(4); }
```

`#EACHP:` 排在 `#EACH:` 之前、`#IFP:` 排在 `#IF:` 之前——凡是一個
前綴是另一個前綴的字首延伸（`#EACH:` 是 `#EACHP:` 拿掉 `P:` 換成
`:` 的結果，兩者共享 `#EACH` 這五個字元），比對次序一定要長的在前，
不然短的分支會先「假裝」比對成功。

同時修正 `inspectTemplatePlaceholders_()`：`usedLists` 原本只收
`type === 'EACH'`，改成 `type === 'EACH' || type === 'EACHP'`——
段落層與列層清單標記，對「系統有沒有提供這個清單」而言是同一件事，
範本選哪一種展開方式純粹是排版考量，不應該影響對帳結果。

### 留低咗啲乜

- `src/DocxTemplate.gs`：`findPlaceholders_()` 前綴比對次序，docstring
  講明「一律不可以歸入 `'SIMPLE'`」。
- `src/BulletinRender.gs`：`inspectTemplatePlaceholders_()` 的
  `usedLists` 同時收 `EACH`／`EACHP`。
- `tests/docxtemplate.test.js`：`findPlaceholders_` 的「六種類型都認得
  出來」測試原本只測了五種（漏了 `EACHP`），已經補上——這正是這個
  bug 能夠混進來、Node 測試卻沒有事先攔住的原因：**測試矩陣本身漏了
  一個型別，不是邏輯本身沒測。** 幫「一組互斥前綴」寫分類測試時，
  一定要把清單跟程式碼裡實際存在的分支逐一對照，而不是憑印象數
  「應該有幾種」。
- `tests/bulletinrender.test.js`：新增 `#EACHP:ANNOUNCEMENT` 對帳為
  「有提供」的整合測試（由真正入口 `inspectTemplatePlaceholders_()`
  叫下去）。
- 同一輪也一併補上 `buildRenderContext_()` 漏掉的
  `FINANCE_TITLE`／`FINANCE_NOTE`／`FINANCE_BALANCE` 三個單值佔位符
  （prompt9 §1.6 原本就要求，前一輪漏做），以及 `DUTY`／`NEXT_DUTY`
  兩個清單在「系統提供但範本沒用到」報告裡加註
  「（正常，範本改用編號佔位符）」——這兩件事跟本事故是同一份使用者
  回報帶出來的，但成因各自獨立，不算同一個 bug class。

---

## 事故二十：「完成度自我檢測」的季度推算沒有退回機制，職事表缺一年資料就整個報不出來，而且兩個檢測項各自猜了一次

發生日期：2026-08-21（事故十九解決之後，Ivan 用真實資料實測「完成度自我
檢測」發現）

### 現象

職事表沒有 2026 年的資料時，「完成度自我檢測」的「PersonDisplay 尊稱
未設定人數」與「本季待填欄位總數」兩項雙雙顯示「無法計算」，各記一個 🟡，
而且報告完全沒有講「為什麼算不到」——只看得到結果，看不出是職事表真的
沒資料、還是別的原因。

### 根因

`selfCheckResolveCurrentQuarterId_()`（原本在 `SelfCheck.gs`）只有一條
推算路徑：「下一個要寄的主日」推算不到就退回 Config `ROSTER_TEST_DATE`，
兩者都要職事表剛好有那個日期的資料才算成功，沒有更後面的退路——一旦
職事表缺這一年的資料（例如年度交接期，新一年的職事表還沒排出來），
兩層都失敗，直接回 `null`，兩個檢測項只能顯示「無法計算」，**沒有任何
中間狀態**（例如「改用其他季度的資料」）。

而且 `selfCheckDataItems_()` 內部「尊稱未設定人數」那一段又**自己重新
算了一次** `refDate`（`guessNextBulletinSendIso_() || getConfig(ROSTER_TEST_DATE)`），
跟 `runSelfCheck_()` 最上層算的 `currentQuarterId` 是兩次獨立呼叫——
理論上兩次應該永遠算出同一個結果，但這是**兩個真相來源**（見本文件
「本專案要反覆自問的 bug class」第 3 條），日後兩段程式碼只要有一段
改動了推算規則而漏改另一段，就會出現「尊稱未設定」跟「待填欄位總數」
報不同季的怪事，而且沒有任何機制會提醒。

### 修法

1. 新增 `src/QuarterResolve.gs`，把季度推算收成**單一真相來源**
   `resolveWorkingQuarter_()`，四層依序退回：
   Config `WORKING_QUARTER_ID` 手動指定 → 下一個要寄的主日 →
   `ROSTER_TEST_DATE` → `BulletinWeeks` 現有資料裡主日數最多且最接近
   今日的季度。全部失敗才回 `ok:false`，而且**每一層都留一句中文
   note**，講清楚試過什麼、為什麼不成功——不可以靜靜退回不講理由
   （呼應本文件第 2 條「缺失被當成正常值靜靜過」）。
2. `runSelfCheck_()` 現在**只呼叫一次** `resolveWorkingQuarter_()`，
   把結果向下傳給 `selfCheckDataItems_()`；後者不再自己重算
   `refDate`，兩個檢測項共用同一個 `quarterId`，消除了兩個真相來源。
3. 報告新增「檢測季度」這一項，訊息明確講出用了哪一層、為什麼
   （例如「本季 2026T3（職事表沒有下一個主日的資料，改用設定值
   ROSTER_TEST_DATE 推算）」），並在 `Diagnostics` 報告最上方加一行
   摘要，方便一眼看出這次算出來的「本季」是哪一季、怎麼算出來的。
4. `guessRosterTestQuarterId_()`（`RosterDiagnostics.gs`，「測試讀取
   職事表（全季）」「建立本季空白週報」兩個選單的預設值來源）改成
   直接呼叫 `resolveWorkingQuarter_()`，消除另一處獨立的「猜季度」
   邏輯——這正是本文件反覆強調的「找出全部推算同一件事的地方，
   收歸一處」。

### 留低咗啲乜

- `src/QuarterResolve.gs`：`resolveWorkingQuarter_()` 與其四層各自的
  輔助函式（`tryResolveQuarterForIsoDate_()`／`checkQuarterExistsInRoster_()`／
  `pickLatestBulletinWeeksQuarter_()`）。
- `src/SelfCheck.gs`：`runSelfCheck_()`／`selfCheckDataItems_()`／新增
  `selfCheckQuarterItem_()`；`selfCheckResolveCurrentQuarterId_()` 整個
  刪除（不留相容殼子，因為確定沒有其他呼叫方）。
- `src/RosterDiagnostics.gs`：`guessRosterTestQuarterId_()` 改為委派
  `resolveWorkingQuarter_()`。
- `src/Rehearsal.gs`：`menuRunQuarterRehearsal_()` 補上由
  `resolveWorkingQuarter_()` 算出的預設季度 ID（原本完全沒有預設值）。
- `tests/quarterresolve.test.js`：15 個測試，涵蓋四層各自成功／失敗、
  格式不符退回下一層、`WORKING_QUARTER_ID` 覆寫（含指定季度不存在）、
  由 `runSelfCheck_()` 真正入口驗證兩項共用同一個 `quarterId`、
  `Diagnostics` 截斷機制仍然生效。
- **沒有改動** `autoCreateNextQuarterFillGrids_()`（「下一季提示」）：
  查過之後發現它根本不是「由日期猜季度」這一類——它是直接掃描
  `BulletinWeeks` 已有的全部季度、找出還沒建立填寫表的那些，每一季
  都會處理到，不是只挑「當前一季」，所以不適用
  `resolveWorkingQuarter_()`（那是「猜一個代表性的季度」，語意跟
  「列出全部欠缺的季度」不同）。見 `docs/待確認事項.md`。

---

## 事故二十一：報告被自己的明細擠爆——固定上限的輸出區，長度不受控的明細排在結論之前

發生日期：2026-08-21（事故二十解決之後，Ivan 實測「完成度自我檢測」
發現）

### 現象

跑一次「完成度自我檢測」，報告寫了 **302 行**，其中 **266 行是待填欄位
明細**（每個待填欄位一行）。`DIAGNOSTICS_MAX_ROWS` 是 380，這一次剛好
沒超過，但只要職事表資料再多一點（多過一季、主日更多、待填更多），
明細會直接把上限吃光，排在後面的「功能類」與「紀錄類」檢測項（觸發器、
Web App、工作表保護、範本佔位符對帳、ErrorLog、SendLog、AuditLog）
就會**被截掉**——connector 與人手都讀不到，燈色數字仍然對，但看不到
是哪一項出事。

### 根因

`buildSelfCheckReportLines_()` 原本是**單一序列**：逐一走訪
`summary.items`，每個項目印完結論行**立刻接著**印它的 `detail`
（尊稱未設定名單、待填欄位逐欄位明細），全部混在一起交給
`writeDiagnosticsReport_()` 的通用截斷機制處理。這個通用機制只認
「第幾行」，不知道「這一行是結論還是明細」——**長度不受控的明細**（待填
欄位數量隨資料量線性成長，沒有上限）跟**數目有限、每次都差不多的結論**
（固定四大類幾十個項目）混在同一個序列裡，明細排在前面的項目就會把
後面項目的結論擠出截斷範圍之外。這正是「固定上限的輸出區，長度不受控
的內容沒有被隔離」這一類問題——`docs/已知bug類型.md` 第 2 類（缺失被
當成正常值靜靜過）的變體：這裡不是「缺失沒有訊息」，而是「重要的結論
訊息被不重要的明細擠到看不見，而且沒有任何提示」。

### 修法

1. **兩段式組報告**：`buildSelfCheckReportLines_()` 先把全部
   `summary.items` 的**結論行**（不含 `detail`）組好——這一段行數
   固定、可預期，**保證完整寫入**。算出 Config `SELFCHECK_MAX_ROWS`
   與 `DIAGNOSTICS_MAX_ROWS` 兩者較小值，扣掉結論段用掉的行數，剩餘
   額度才依序寫各項目的 `detail`；放不下就在那個項目的明細最後補一句
   截斷提示，然後整份報告到此為止——不會有任何一個項目的明細，擠掉
   後面項目的結論。
2. **明細本身也要有自己的上限**：「本季待填欄位總數」的明細改成
   **逐主日彙總**（`selfCheckMissingSummaryByDate_()`），一個主日一行，
   不是一個欄位一行，並且用新 Config `SELFCHECK_MISSING_DETAIL_ROWS`
   （預設 20）另外截斷，超過的部分寫「尚有 N 項未列出，請用選單
   『本季待填清單』查看完整明細」——`N` 是被截掉那些主日的待填欄位
   **總數**，不是估算。
3. **完整明細另開一個專門的地方放**：新增選單「本季待填清單」
   （`menuShowQuarterMissingFieldsList_()`），輸出不受
   `SELFCHECK_MISSING_DETAIL_ROWS` 限制的完整逐欄位明細，自己的報告
   遵守 `DIAGNOSTICS_MAX_ROWS`。自我檢測報告的截斷提示直接指路到這個
   選單，Ivan 不會卡在「看不到完整清單」。
4. **燈色判定完全不動**：兩段式只改「寫幾多行進 `Diagnostics`」，
   `totalMissing === 0 ? GREEN : YELLOW` 這種判斷邏輯原封不動，跟
   輸出行數上限完全脫鉤（見 `tests/selfcheck.test.js` 19j：同一組資料，
   `SELFCHECK_MAX_ROWS` 設 10 跟設 10000，🟢🟡🔴 數目一致）。

### 留低咗啲乜

- `src/SelfCheck.gs`：`buildSelfCheckReportLines_()` 改兩段式；新增
  `selfCheckResolveMaxRows_()`／`selfCheckDetailTruncationTrailer_()`／
  `selfCheckMissingSummaryByDate_()`／`selfCheckCapMissingSummary_()`；
  新增 `buildQuarterMissingFieldsReportLines_()`／
  `menuShowQuarterMissingFieldsList_()`。
- `src/Constants.gs`：新增 Config 鍵 `SELFCHECK_MAX_ROWS`（預設 140）、
  `SELFCHECK_MISSING_DETAIL_ROWS`（預設 20）。
- `src/Menu.gs`：新增選單項目「本季待填清單」，放在「完成度自我檢測」
  旁邊。
- `tests/selfcheck.test.js`：新增 19a–19j 共 10 個測試，涵蓋
  500 項待填仍不超過行數上限、後段紀錄類檢測項目不被擠掉、明細截斷
  數值精確、`SELFCHECK_MAX_ROWS` 大於 `DIAGNOSTICS_MAX_ROWS` 時取小值、
  由真正入口跑「本季待填清單」、燈色判定不受行數上限影響。
- **一般原則**：任何「固定上限的輸出區」（`Diagnostics`、對話框、
  郵件內文……），只要同時要放「數目有限的結論」跟「長度不受控的
  明細」，一律要先幫結論保留額度，明細用剩餘額度寫，而且明細本身
  也要有自己的上限，不能指望外層的通用截斷機制去公平分配——它不知道
  哪些行比較重要。

---

## 事故二十二：驗證函式與被驗證的邏輯用同一個假設，等於沒有驗證

發生日期：2026-08-22（Ivan 用最新 `TPL_NORMAL` 產生 `2027-11-07` 週報之後
發現）

### 現象

產出的 `.docx` 上，這一整段原封不動印在紙上：

```
{{#EACHP:ANNOUNCEMENT}}{{ANNOUNCEMENT.NO}}. {{ANNOUNCEMENT.TEXT}}
```

但產生完的對話框報告：

```
替換的佔位符: 47 個
找不到值的佔位符: 0 個
疑似被切斷的佔位符: 0 個
```

**三個數字全部話冇事，實際上有三個佔位符原封不動印咗出嚟。**

### 根因（兩層，要分開講）

#### 第一層：報告本身冇驗證能力

`replacedCount`／`missingKeys`／`broken` 三個數字，**全部係渲染流程自己
喺過程中累加出嚟嘅**，用嘅係同渲染完全一樣嗰套假設：

- `replacedCount` 數嘅係「我成功換咗幾多個」——換唔到嘅嘢佢根本唔知有。
- `missingKeys` 只由 `replaceSimplePlaceholders_()` 產生，而佢**刻意唔碰**
  `#` 開頭（清單／條件標記）同帶點嘅（`{{OBJ.FIELD}}`）鍵。所以清單標記
  處理唔到，`missingKeys` 一定係 0。
- `broken` 係 `findBrokenPlaceholders_()` 喺**已經合併過**嘅 XML 上面搵
  「跨 `<w:t>` 嘅碎片」。`{{#EACHP:ANNOUNCEMENT}}` 合併之後係一個
  **完整**嘅佔位符，所以佢唔算「被切斷」，一樣係 0。

三個指標各有各嘅盲點，而三個盲點**啱啱好重疊喺同一個情況**：一個語法
完整、但冇人處理得到嘅清單標記。冇任何一個指標會出聲。

**呢個就係「驗證函式與被驗證的邏輯用同一個假設」**：`findBrokenPlaceholders_()`
本來就係為咗捉「佔位符印咗出嚟」而寫嘅，但佢同替換邏輯**共用「已經
合併好」呢個前提**。前提啱嘅時候佢捉唔到呢一類；前提錯嘅時候佢會同
替換邏輯**一齊錯**——兩邊都以為冇嘢。一個同被測對象共用假設嘅驗證，
喺最需要佢嗰陣一定失靈。

#### 第二層：合併只救得到「格式完全相同」嗰種切法

本輪按 prompt 要求，先抽出真實 `TPL_NORMAL` 嘅 `word/document.xml` 驗證
過（結果詳見 `docs/待確認事項.md` I-1）：嗰段確實被 Word 切成 **3 個
`<w:r>`**，中間夾 `<w:proofErr>`：

```
{{#  |  EACHP:ANNOUNCEMENT}}{  |  {ANNOUNCEMENT.NO}}. {{ANNOUNCEMENT.TEXT}}
```

但三個 run 嘅 `<w:rPr>` **一模一樣**，所以 `mergeRunsInParagraphs_()`
救得返（實測合併後 69 個佔位符全部完整）。即係話**用現行程式碼加現行
範本，重現唔到嗰個殘留**。

真正救唔到嘅係另一種：**被切開嘅幾個 run 格式唔同**（其中一個字元不小心
變咗字型大小、或者 `w:lang` 唔同）。`mergeRunsInParagraphs_()` 嘅合併條件
係「`<w:rPr>` 原文一字不差相同」，格式一唔同就唔合併 → 佔位符永遠拼唔返
完整 → 原封不動印出嚟。呢個窿實測確認存在。

### 修法

1. **加第二道防線 `collapseSplitPlaceholderParagraphs_()`**（`src/DocxTemplate.gs`）：
   凡係「整段合併之後認得出、但逐個 `<w:t>` 分開睇就認唔出」嘅段落，
   就將嗰段自己嘅全部 `<w:t>` 壓平到第一個，其餘設空字串，保留第一個
   run 嘅格式。
   - **排除巢狀 `<w:txbxContent>`**：文字方塊入面係另一個段落嘅內容，
     撈埋落嚟會憑空拼出假佔位符，寫返去更加會搬走文字方塊嘅內容。
   - **只動真係被切開嗰啲段落**：冇佔位符、或者佔位符本來就完整落喺
     單一 `<w:t>` 內嘅，一律原封不動——壓平會拉平段落內原本嘅混合格式，
     冇必要就唔應該做。
2. **兩條路徑合併成一個入口 `prepareXmlForPlaceholders_()`**：渲染
   （`renderDocumentXml_()`）同範本對帳（`inspectTemplatePlaceholders_()`）
   一定要用同一個。以前對帳只做 `mergeRunsInParagraphs_()`，兩邊對「佔位符
   長咩樣」有唔同假設，就會出現「對帳報冇問題、渲染卻填唔到」。
3. **加真正嘅產出驗證 `scanDocxResidualPlaceholders_()`**（`src/DocxIo.gs`）：
   產生完之後**重新解壓真正嘅產出 blob**，逐個文字部件（`document.xml`、
   `header*.xml`、`footer*.xml`）用最寬鬆嘅 `{{` 實掃。呢條路徑同渲染
   **冇任何共用假設**——渲染點錯法都好，佢照樣睇到紙上有冇 `{{`。
   - 對話框新增一行「殘留佔位符：N 個」，**排喺其餘統計之上**。
   - `N > 0` 時：標題改成警告、列出頭三個殘留內容、寫入 `ErrorLog`。
   - 掃描本身失敗回 `count: -1`——**「驗證不到」同「冇問題」必須分得清楚**，
     唔可以當成 0。
4. 用最寬鬆嘅 `{{` 而唔係完整佔位符樣式去掃：殘留物本身就有可能係壞嘅
   （`{{SERMON_TITLE`、`{{ SERMON_TITLE }}`），用嚴格樣式反而會漏報。

### 留低咗啲乜

- `src/DocxTemplate.gs`：`paragraphOwnTextRanges_()`／`paragraphMergedText_()`／
  `paragraphHasSplitPlaceholder_()`／`collapseParagraphTextIntoFirstNode_()`／
  `collapseSplitPlaceholderParagraphs_()`／`prepareXmlForPlaceholders_()`／
  `scanResidualPlaceholders_()`；`renderDocumentXml_()` 第 1 步改用新入口，
  `stats` 新增 `collapsedParagraphs`。
- `src/DocxIo.gs`：`isDocxTextPartName_()`／`scanDocxResidualPlaceholders_()`。
- `src/BulletinRender.gs`：`generateBulletinDocx_()` 產生完實掃並寫
  `ErrorLog`；新增 `buildResidualPlaceholderMessage_()`（對話框同 `ErrorLog`
  共用同一句）與 `buildGenerateResultDialogLines_()`；
  `inspectTemplatePlaceholders_()` 改用 `prepareXmlForPlaceholders_()`。
- `tests/splitrun.test.js`：26 個測試。當中兩個**反向鎖**最重要——
  一個證明「三個自報數字全部話冇事，但實掃捉到殘留」真係會發生，
  另一個證明「舊嘅合併單獨救唔到格式唔同嗰種切法」，所以第二道防線
  唔係多餘。
- `tests/docxtemplate.test.js`／`tests/bulletinrender.test.js`：兩個原本
  斷言「呢個案例會被報成 broken」嘅測試，改成斷言「而家救得返」，
  並各自補一個**真正救唔到**（跨兩個段落）嘅案例，確保第二道防線唔會
  反過嚟掩蓋真問題。

### 一般原則

**驗證一件事嘅時候，驗證路徑同被驗證嘅路徑唔可以共用假設。** 具體嚟講：

- 唔可以用「我做咗幾多」倒推「做得啱唔啱」——`replacedCount` 高極都
  唔代表冇漏。
- 驗證應該由**產出物**出發（重新讀返個檔、重新掃一次），唔係由**過程**
  嘅記帳出發。
- 如果驗證函式同被驗證嘅邏輯係同一個人寫、共用同一批 helper、對資料
  形狀有同一套前提，就要特別警惕：前提一錯，兩邊會一齊錯，而且會
  **一齊報冇事**——比冇驗證更危險，因為佢畀咗你虛假嘅安全感。

---

## 事故二十三：一次操作有幾個步驟，其中一步失敗要回「成功」還是「失敗」，答案不是同一個

**症狀（尚未發生，發佈那一輪設計時擋住的）**

發佈一次要做三件事：

1. 原地覆寫 master PDF（會眾撳條連結睇到嘅嘢）
2. 存一份帶日期與版本號的副本
3. 寫 `PublishLog`

最直覺的寫法是三件事包在一個 `try`，任何一步拋錯就回「發佈失敗」。
這樣寫的話，**第 2 步失敗會令幹事收到「發佈失敗」——而那一刻 master
已經換好，會眾撳連結看到的已經是新一期。**

幹事見到「失敗」會做甚麼？再發佈一次。於是版本號白白多跳一級，
`PublishLog` 多一行，而實際上第一次已經成功了。

**根本原因**

「這一步失敗了」與「這次操作失敗了」是兩件不同的事，但寫程式時很容易
用同一個 `catch` 表達。判斷準則不是「有沒有拋錯」，而是：

> **這一步失敗之後，外面的世界有沒有已經被改變？**

- 第 1 步失敗 → 外面沒有任何改變（master 還是舊那一份）→ 整次算失敗，
  `PublishLog` **一行都不可以寫**。寫了的話，頂部狀態列會顯示「已發佈
  第 3 版」而連結裡面還是第 2 版，一個沒有人查得出的假象。
- 第 2 步失敗 → **外面已經改變了**（master 換了）→ 整次算成功，照寫
  `PublishLog`，另外回一句「存檔副本存不到，請人手補存」。

兩者的處理是**相反**的，所以一定要分開兩個 `try`。

**修法**

`executePublish_()`（`src/Publish.gs`）用兩個獨立的 `try`：

```js
try {
  overwriteMasterPdf_(...);          // 失敗 → 立刻 return {ok:false}
} catch (err) {
  appendErrorLog_(...);
  return { ok: false, reason: classified.code, message: classified.message };
}

try {
  archive = saveArchivePdfCopy_(...); // 失敗 → 記低，繼續行落去
} catch (err2) {
  archiveError = ...;
  appendErrorLog_(...);
}
// 兩種情況都會行到呢度寫 PublishLog
```

由 `tests/publish.test.js` 第 9 與 9b 兩條分別守住——**兩條測試斷言的是
相反的結論**，這一點本身就是這一則事故的重點。

**一般化**

任何「多步驟、每步都可能失敗」的操作，寫 `catch` 之前先逐步問：

1. 這一步之前，有沒有任何**外部可見**的改變已經發生？（Drive 檔案、
   寄出去的郵件、外部系統的資料）
2. 有的話，回「失敗」就是講一句與事實相反的話——使用者會據此做出錯誤
   的補救動作（重試、重新發佈、再寄一次）。
3. 沒有的話，才可以乾淨地回「失敗」，而且要保證**一格都沒有寫**。

順帶一提：這也是為甚麼「先驗證、後動手」的次序不可以調轉。
`runPublishFlow_()` 把 PDF 驗證、「從未發佈過」檢查、發佈前檢查
（R-006／R-007）全部排在任何 Drive 或工作表寫入之前——那一段全部失敗
都可以乾淨地回「失敗」，因為外面一格都未動過。

---

## 事故二十四：Shared Drive 上的 Drive 進階服務要 `supportsAllDrives`，否則回一句假的 404

**症狀**

Web App 撳「確認發佈」之後：轉圈完結，**確認視窗不關、按鈕仍在、沒有任何
訊息**。使用者撳了兩次。master 檔案的內容完全沒有變。

去查的話會見到 `Drive.Files.update()` 拋出

```
File not found: 1AbC…
```

**這一句是假的。** 檔案就在 Shared Drive 上，用瀏覽器開得到，執行帳戶也
有權限，ID 一個字元都沒有貼錯。

**根本原因**

本專案所有檔案都在 **Shared Drive**（共用雲端硬碟）。Drive 進階服務
（`Drive.Files.*`）**預設只看「我的雲端硬碟」**——不是「找不到」，是
「沒有去那邊找」。要它連共用雲端硬碟一起處理，每一個呼叫都必須帶

```js
Drive.Files.update({}, fileId, blob, { supportsAllDrives: true });
```

列檔案／搜檔案的呼叫還要多一個 `includeItemsFromAllDrives: true`
（前者是「我懂得處理共用雲端硬碟的檔案」，後者是「結果裡請包含共用雲端
硬碟的項目」，兩者缺一不可）。

**為什麼特別難查**

因為錯誤訊息**指向一個不存在的原因**。「File not found」會令人去查：
檔案在不在？ID 對不對？權限夠不夠？被人刪了嗎？——**每一項都會查出
「沒問題」**，於是只好懷疑自己的眼睛。真正的原因（少了一個參數）跟
訊息完全無關，不可能靠讀訊息想到。

同一類陷阱還有 `DriveApp.searchFiles()`：它**預設不搜共用雲端硬碟**，
所以「這個檔名有沒有撞」永遠答「沒有撞」。這個更陰險——它不會報錯，
只會靜靜地給一個錯的答案。本專案的 `uniqueOutputFileName_()` 原本就是
這樣寫的（用 `Folder.getFilesByName()`），已經一併改掉。

**修法**

1. **全部 `Drive.` 呼叫集中在 `src/DriveShared.gs` 一個檔案。**
   選項物件由 `driveSharedOptions_()` 產生——單一真相來源，只有一處會
   寫漏。其他檔案一律叫包裝函式，不自己寫選項。
2. **新增靜態檢查 `tools/lint-drive-shared.js`**（兩條規則）：
   - 任何 `Drive.Files.`／`Drive.Drives.` 呼叫，同一個語句內必須有
     `supportsAllDrives`，或者用了共用包裝。
   - **共用包裝自己一定要有那個參數**——第一條容許的那個「豁免」，靠
     第二條堵住。少了它，包裝一旦漏掉，全部呼叫點都會靜靜失去支援，
     而 lint 照樣回 0。
3. **測試替身照樣模擬那個症狀**：`tests/publishfix.test.js` 的假 Drive
   在缺少 `supportsAllDrives` 時會拋 `File not found`。日後有人把參數
   拿走，測試會表現成一模一樣的症狀，而不是靜靜通過（第 5b 條專門驗
   替身本身有沒有這個能力——替身如果對缺參數毫無反應，其餘幾條測試
   就全部是假的保障）。

**一般化**

用任何雲端 API 之前，先問一句：**「這個 API 的預設搜尋範圍是甚麼？」**
很多 API 的預設值是「只看最常見那一種容器」，而本專案用的偏偏是另一種。
這一類設定的共同特徵是：**不帶它不會報錯，只會回一個看起來合理、其實
是錯的答案**（找不到／沒有結果／沒有撞名）。

---

## 事故二十五：前端沒有失敗處理，等於後端錯誤全部消失

**症狀**

同一次事故的另一半。就算後端已經把錯誤分類好、訊息寫得清清楚楚、
`ErrorLog` 也記了一筆，使用者**一個字都看不到**——畫面上只有轉圈結束、
視窗還開著、甚麼都沒有發生。於是再撳一次。

**根本原因（兩件事疊在一起）**

1. **`google.script.run` 的 `withFailureHandler` 是可以不寫的。**
   不寫也不會有任何警告；後端拋的例外就直接掉進地上，前端連「失敗了」
   這件事都不知道。而 `beginRequest()` 那一邊已經加了一，永遠不會有人
   幫它減回來——介面就此停在忙碌狀態。

2. **`google.script.run` 沒有逾時機制。** 伺服器那一邊如果卡住（拿不到
   鎖、Drive 慢、撞到 6 分鐘上限），**成功與失敗兩個處理函式都不會被
   呼叫**。就算兩個都寫齊了，這一種情況一樣是永遠轉圈。

3. 錯誤訊息寫在**視窗下面**那條訊息列。確認視窗是 modal，蓋住了它——
   寫了等於沒寫。

**修法**

`src/ui/Script.html` 新增 `callServer(fnName, args, onOk, options)`，
**全部**伺服器呼叫都經它（`tests/publishfix.test.js` 第 12 條靜態掃描
`src/ui/`，全目錄只准有一個 `google.script.run`，而且要在 `callServer()`
裡面）：

- 成功、失敗、逾時三條路徑都經同一個 `settle()`，所以忙碌狀態**只可能
  解除一次，也不可能漏**。逾時之後才回來的回應會被 `settled` 擋掉。
- 逾時上限來自 Config `WEBAPP_CALL_TIMEOUT_SEC`（預設 120 秒），由
  `doGet` 放進 `#app` 的 data 屬性帶給前端。
- 錯誤訊息取後端訊息的頭 300 字（完整內容在 `ErrorLog`），而且**在
  modal 視窗之內**也顯示一份。
- 逾時那一句刻意寫明「這一次的動作**可能已經做了、也可能沒有做**，
  請先查 `ErrorLog` 與『執行項目』，不要直接再按一次」——逾時跟失敗
  不同，它**不代表沒有做**，叫人重試是危險的建議。

`src/ui/FillConflict.html` 是另一個獨立文件（modal dialog），共用不到
那一份，所以另寫一份精簡版的 `callServer()`。

**一般化**

- **「沒有寫失敗處理」不會有任何徵狀，直到它真的失敗那一天。** 凡是
  「可以不寫、不寫也不報錯」的錯誤處理，一律要有一個地方統一寫好，
  再加一個靜態檢查逼所有人經過它。靠自律記得寫，遲早有一個漏網。
- **「沒有回應」跟「回應說失敗」是兩種不同的狀態**，訊息不可以一樣。
  前者要叫人去查、不要重試；後者可以叫人改正再試。
- 訊息要顯示在**使用者當下看得到的那一層**。有 modal 蓋住的時候，
  底層的訊息列等於不存在。

---

## 事故二十六：測試的證據來源是人手砌的狀態，不是系統跑出來的狀態

**症狀**

不是單一個 bug，是**至今每一個 bug 的共同形狀**：

| 事故 | 為甚麼測試是綠的 |
|---|---|
| 佔位符跨 `<w:r>` 沒處理 | fixture 是單一個 `w:t`，Word 實際不會這樣輸出 |
| Shared Drive 的 `Drive.Files.update` 回 404 | 測試 mock 了 Drive，mock 不會 404 |
| 產出驗證報「殘留 0」而實際有 3 | 驗證函式與被驗證的邏輯用同一個假設 |
| 人數表空白時欄寬崩掉 | 沒有人渲染過一份全空的週報 |

**根本原因**

單元測試問的是「**這一支函式對不對**」，而它拿到的輸入是**我寫測試時
想像得到的輸入**。想像不到的形狀（Word 真正的輸出、Shared Drive 真正的
回應、使用者真正的操作次序），測試永遠碰不到。

⚠️ **所以「加多幾條測試」是錯的回應。** 再加一百條同一種測試，只會令
假綠燈更多——因為它們的證據來源完全一樣。要換的是**證據來源**。

**修法：四層，每一層換一種證據來源**

| 層 | 證據來源 | 擋甚麼 |
|---|---|---|
| 1 不變量 | **系統現在的狀態自己** | 「畫面的數字與工作表對不上」 |
| 2 真環境自測機 | **真實入口跑出來的狀態** | 「fixture 造不出的狀態」 |
| 3 亂行機 | **隨機的操作次序** | 「沒有人想過要這樣按」 |
| 4 產出實物斷言 | **產出檔案本身** | 「報告說沒事，成品其實有事」 |

不變量跟單元測試的角色**完全不同**：單元測試問「這一支函式對不對」，
不變量問「**系統現在這個狀態自己對不對得住自己**」。它不需要知道系統是
怎樣走到這個狀態的——所以它抓得到「沒有人想過要這樣按」造出來的狀態，
而那正是單元測試的盲區。

**三個狀態，不是兩個**

每一條不變量、每一個情境都回**三種**結果：成立／不成立／**驗證不到**。

⚠️ 「驗證不到」絕對不可以當成「沒問題」。這是本專案犯過的錯——
`scanDocxResidualPlaceholders_()` 用 `-1` 而不是 `0` 就是為了這件事。
自測機報告的「略過」那一段還會明寫「『略過』不等於『通過』」。

**這一輪自己也踩了一次**

`runInvariantI02_()` 第一版寫 `if (seen[key])` 判斷重複，而 `seen[key]`
存的是列索引——第一行的索引是 `0`，`0` 是 falsy，所以「**第一行被重複**」
這種情況永遠驗不出來。

它是被 `tests/invariants.test.js` 那條「應該紅」的案例當場抓到的。這正是
為甚麼那個檔案定下一條紀律：**每一條不變量都必須有一個「應該紅」的案例**
——只驗「正常情況下是綠」的話，一支永遠回 `true` 的函式也會全部通過。

**一般化**

- 寫測試之前先問：「**我這個 fixture 是我想像出來的，還是系統真的產生
  出來的？**」如果是前者，這條測試抓不到「我想像錯了」那一類 bug。
- 任何「檢查」都要問：「它的證據來源，跟被檢查那件事的證據來源，是不是
  同一個？」是的話，兩者會一齊錯、一齊報沒事。
- 「我做咗幾多」（替換數、成功數）**不是**證據。「產出物裡面有沒有」
  才是。
- 每一個斷言都要有一個「應該紅」的案例，否則你只證明了它「不會誤報」，
  沒有證明它「捉得到」。

---

## 事故二十七：有副作用／不是恆真的檢查，不可以當成「不變量」

**症狀**

第一輪自測機跑完：18 個情境，11 個紅。但**其中 8 個的原因是同一個**——
S08、S10、S11、S12、S16、S17 這些跟匯入完全無關的情境，紅的理由都是
`I08 匯入之後再匯入一次，改動必為 0` 這一條不變量不成立。

那 8 個情境本身做的事（發佈、寄信、備份、還原……）根本沒有碰過匯入。

**根本原因（兩層）**

第一層，**I08 不是恆真的**。不變量的定義是「**無論系統在哪一個狀態，
這句話都成立**」。而「再匯入一次改動必為 0」只在**啱啱匯入完那一刻**
成立：內容表有人改過一格、或者這個季度根本未匯入過，它就自然不成立
——那不是 bug，那是正常。

第二層，**它有先決條件，而先決條件本身有副作用**。要驗證「再匯入一次
是 0 改動」，你必須先有一次匯入。把這種檢查放進「每一個情境跑完都要跑
一次」的全域不變量集合，等於在每個情境後面偷偷插一次匯入。

兩層加起來的後果是最難查的那種：**紅燈出現在不相干的地方**。看報告的人
會以為「發佈壞了」，其實發佈好好的，壞的是檢查本身放錯了位置。

**修法**

1. 每一條檢查都要**明明白白**標注 `sideEffect: true` 還是 `false`。
   不可以靠「沒有寫就當作沒有副作用」——漏寫與「確認過沒有副作用」
   在程式碼裡面看起來一模一樣。
2. `runAllInvariants_()` **只跑** `sideEffect: false` 那些。
3. 有副作用的另開一支 `runStatefulChecks_()`，只在**它有意義的情境**
   （S05／S06／S07 這三個匯入情境）叫。
4. 測試要有一條「`runAllInvariants_()` 裡面一條 `sideEffect: true` 都
   沒有」——防止日後有人手滑加回去。

**留下了什麼**

`src/Invariants.gs` 檔頭多了一段「⚠️ 不是每一條檢查都是『不變量』」，
把上面兩層原因寫在下一個人一定看得見的地方。

**一般化**

- 「不變量」這三個字要當真：**不是任何時候都成立的，就不是不變量**，
  無論它看起來多重要。它是一條「後置條件」或者「情境斷言」，要跟著
  它適用的情境走。
- 一個檢查如果**需要先做一件事**才驗得到，那件事就是它的副作用——
  即使那件事本身是安全的、可重複的。
- 紅燈的**位置**與紅燈的**原因**必須對得上。一條檢查會令不相干的情境
  變紅，這條檢查就放錯了地方；先修位置，再修內容。

---

## 事故二十八：設計上是文字的欄位，寫入前沒有設純文字格式——試算表會自作主張轉型

**症狀**

第一輪自測機的 `I08`（匯入之後再匯入一次，改動必為 0）永遠不成立。
`AuditLog` 給出了完整的證據：

```
CONTENT_SHEET_IMPORT | Finance | 2027-10-03 | COL_SPECIAL_OVERSEAS
舊值 42150 | 新值 42,150
```

內容表存的是文字 `42,150`。匯入把它寫進 `Finance`，讀回來變成數字
`42150`。下一次匯入比較「現在是 42150、應該是 42,150」→ 不同 → 再寫一次
→ 再被轉走。**永遠不會停**。

兩個後果，一個吵一個靜：

- 吵的：匯入永遠不冪等，每次都報一堆「有改動」，`AuditLog` 被灌爆。
- 靜的（更嚴重）：**週報印出來的金額沒有了千分位逗號**，變成「42150」。
  沒有人會為此收到警告。

**根本原因**

`setValue('42,150')` 在一個**不是純文字格式**的儲存格上，Google Sheets
會把它當成「一個帶千分位的數字」而存成 `42150`。同樣地 `'007'` 會變成
`7`、`'10/5'` 會變成一個真正的日期。

專案本來就有這道防線——`COLUMNS.*.textFormatColumns` 加上
`ensureSheet_()` 的 `setNumberFormat('@')`。問題是：

1. **`FINANCE` 整項漏了**，五個金額欄一個都沒有登記。
2. `ensureSheet_()` 只在**建表那一刻**按當時的 `getMaxRows()` 設一次。
   資料長過那個範圍、或者工作表是舊版本升上來的，新行就沒有保護。
3. 幾個「一格一格寫」的地方（`writeContentImportPlan_()`、
   `writeBulletinWeekField_()`、`applyWeekFieldChanges_()`、
   `writeWeekCell_()`、`applyListPlan_()`）都是直接 `setValue()`。

⚠️ 次序是關鍵：**格式一定要在 `setValues()` 之前設好**。寫完之後再設
`'@'` 救不回——那時逗號已經沒有了，剩下的只是「把數字 42150 顯示成
文字」。

**修法**

1. `FINANCE` 補回 `textFormatColumns`（五個 `COL_*`）。
2. `applyTextFormatToRange_()`：批次寫入前，按 `textFormatColumns`
   為目標範圍設 `'@'`。`writeSheet()` 每次附加都會叫它。
3. `setCellValueTextSafe_()`：逐格寫入一律經這裡，是文字欄就先設格式。
   上面列的五個寫入點全部改用它。
4. 比對兩邊都經 `normalizeContentCompareValue_()`——特別是 `Date`，
   `String(dateObject)` 得出 `'Mon Oct 04 2027 …'`，永遠不會等於
   `'2027-10-04'`，那一欄就會每次匯入都判定有改動。
5. 一次性修復 `repairTextColumnsStoredAsNumbers_()`（選單「修復被轉成
   數字的文字欄位」），把已經寫壞的舊資料改回文字，並在 `Diagnostics`
   報告修了多少格。

⚠️ 修復**只還原型別，不還原顯示格式**：從數字 `42150` 反推不到原本是
`42,150` 還是 `42150.00`。正確的顯示文字要靠下一次匯入帶回來。報告有
明寫這一點——不可以讓人以為「修完＝資料正確」。

**一個關於測試的教訓（比 bug 本身重要）**

假工作表本來的 `setNumberFormat()` 是 `return this;`（什麼都不做），
`setValue()` 也原樣存起來。**在那個假替身上，修不修都是綠的。**

所以修法的第一步不是改 `src/`，是先教假替身**像真的 Sheets 那樣轉型**
（`applySheetsAutoCoercion()`），再加一條 `0a` 測試證明它真的會轉。
沒有那一步，`tests/textformat.test.js` 三十條全部都是假綠——正是事故
二十二與二十六講的同一件事。

寫的時候還真的踩了一次：heredoc 把正規表達式的反斜線吃掉，
`/^-?\d+$/` 變成 `/^-?d+$/`，假替身於是不會轉型。**是那條 `0a` 當場
抓到的。**

**一般化**

- 「設計上是文字」是一個**欄位屬性**，要登記在單一真相來源
  （`COLUMNS.*.textFormatColumns`），不是靠每個寫入點各自記得。
- 任何「寫入前要先做的準備」，要包成**一支函式**，令「忘記做」變成
  「沒有叫那支函式」——那是 grep 得到的。
- 帶格式的數字（千分位、前導零、日期形狀）落到試算表一律當炸彈看待。
- 修一個「假替身測不出來」的 bug，第一步是**先令假替身測得出來**，
  並且加一條測試證明它測得出來。

---

## 事故二十九：同一條規則只在其中一個入口成立——擋住大門，後門大開

**症狀**

第一輪自測 S09 報告「對唯讀欄位呼叫 `apiSaveWeek` 竟然存得到」。查下去
發現兩件事，第二件比第一件嚴重得多。

**第一件：自測量度了一件不存在的事**

S09 送的 payload 是：

```js
{ week: {}, lists: { announcements: [{ TEXT: '…' }] } }
```

但真正的 payload 把四張清單放在**頂層**（`payload.announcements`）。
`lists` 這個鍵，前端不會送、後端不會讀。所以：

- 防線 `assertContentSheetFieldsNotSubmitted_()` 看不見任何唯讀欄位 →
  不拋錯；
- 寫入邏輯 `buildSaveOperations_()` 同樣看不見 → 什麼都沒有寫。

於是 S09 的兩個斷言「有沒有被拒」與「有沒有寫入」分別得出「沒有被拒」
與「沒有寫入」，報告寫成「**竟然存得到**」——而其實一格都沒有存到。

⚠️ 只認一種形狀的檢查，遇到另一種形狀時**不會報錯，只會靜靜地什麼都
不做**。這比報錯危險得多：報錯會有人去查，靜靜不做只會令人以為驗過了。

**第二件（真正的 bug）：規則有三份，其中一個入口完全沒有**

內容表接管（R-011）之後，「這十五個欄位不可以再由人手寫」這條規則
散在三個地方：

| 地方 | 當時的狀態 |
|---|---|
| 前端 `src/ui/Script.html` | 一個寫死的陣列 `CONTENT_SHEET_WEEK_FIELDS` |
| 後端 `src/WebAppSave.gs` | 由 `contentImportTargets_()` 衍生 |
| **季度填寫表** `src/FillGrid.gs` | **完全沒有** |

季度填寫表是一張真的試算表，幹事直接在上面打字，`syncFillGrid_()` 會把
改動 `PUSH` 回 `BulletinWeeks`。十二個人數欄與宣召兩欄在那裡照樣可以改、
照樣寫得入去。**填寫介面擋得住，格子表繞得過。**

更難查的是：那條路徑當時還有測試**守著錯誤的行為**——
`tests/fillgrid.test.js` 第 5、5b 條斷言「人數欄輸入 `--` 之後
`BulletinWeeks.ATT_CANN_WORSHIP` 等於 `--`」。測試是綠的，綠燈守住的是
一個已經不再正確的承諾。

**修法**

1. `Constants.gs` 的 `CONTENT_SHEET_READONLY_FIELDS` 成為**唯一**真相
   來源，前端由 `apiLoadWeek()` 的 `readOnly.readOnlyFields` 拿，
   後端與格子表直接讀它。
2. 一條測試守住「宣告的清單」與「由 `contentImportTargets_()` 推算出來
   的清單」完全一致——日後新增匯入目標而忘記更新，那條測試會紅。
3. `fillGridColumnDefs_()` 對唯讀欄位**強制** `readOnly: true`，
   `buildFillSyncPlan_()` 根本不會把它排入計畫；`syncFillGrid_()` 的
   `PUSH` 分支再擋一次（兩層，因為第一層是一個容易漏掉的旗標）。
4. 防線兩種 payload 形狀都認，並且把「是哪幾個欄位」放進錯誤訊息與
   `err.readOnlyFields`。
5. S09 改送**真正的形狀**，而且一次驗三種：清單、週欄位、以及
   **唯讀欄位混一個可寫欄位**。
6. `tests/fillgrid.test.js` 第 5、5b 條改成斷言正確的行為，並在註解寫明
   為什麼預期改變了。

**一般化**

- 一條規則要問的不是「有沒有實作」，而是「**有幾多個入口，是不是每一個
  都成立**」。列得出入口清單，再逐個對。
- 同一條規則出現兩份以上，就一定會分岔；分岔的方向如果是「其中一份少列
  了一項」，代價是**靜靜寫錯資料**。
- 「整次拒絕」與「只擋唯讀那幾欄」是不同的行為。後者會造成「一半成功」
  ——幹事以為全部存好了。混了可寫欄位的請求，一樣要整次拒絕。
- 測試也會**守著錯誤的行為**。改需求時要主動問一句「有沒有測試在守著
  舊承諾」，改測試的時候把理由寫在註解裡，否則下一個人會以為是改壞了。
- 自測情境送出去的東西，形狀必須與**真實呼叫方**一模一樣。形狀對不上
  的話，那條自測驗的是一件系統根本不會遇到的事。

---

## 事故三十：算式代表的不是它名字講的那件事——「下一個主日」其實是「假設今日是星期一的話下一個主日」

**症狀**

第一輪自測在 **2026-08-22（星期六）** 跑。自測機 S18「星期一自動寄出：
選中的是下一個主日」報紅，系統選中的目標日是 **2026-08-28**——一個
**星期五**。正確答案是 2026-08-23（星期日）。

**根本原因**

算法是：

```js
targetIso = todayIso + Config.SEND_TARGET_OFFSET_DAYS   // 預設 6
```

這條算式只有在**今日是星期一**時才落在星期日：一 ＋ 6 ＝ 日。它算的其實
是「**假設今日是星期一的話，下一個主日是哪一日**」，而不是「下一個主日」。
變數叫 `targetIso`、設定叫「由觸發日推算要寄哪一個主日的天數」，兩個名字
都講得像是後者。

正式流程裡面觸發器**真的**在星期一跑，所以線上一直沒有出事。一換日子跑
（自測、人手試寄、選單預設值）就答錯——而那三個入口全部都會用到它。

⚠️ **算式的正確性依賴一個沒有寫出來的前提**（「今日是星期一」），而那個
前提在其中一個呼叫方成立、在另外三個不成立。

**三份拷貝，一齊錯**

同一條算式在三個地方各自寫過一次：

| 檔案 | 用途 |
|---|---|
| `Mailer.gs` `guessNextBulletinSendIso_()` | 選單對話框預設值 |
| `Trigger.gs` `weeklyBulletinSendTrigger_()` | 觸發器真正用的目標日 |
| `SelfTest.gs` S18 | **驗證**目標日對不對 |

第三個最要命：**驗證的一方與被驗的一方用同一條算式**。S18 之所以捉到，
純粹是因為它同時還用 `nextSundayOnOrAfter_()` 算了一次「真正的下一個
主日」來對照——如果當初只寫「算出來是不是星期日」，它會照樣綠。

**修法**

1. 新增 `src/SendSchedule.gs`，把定義寫成一句、只寫一次：
   **下一個要寄的主日 ＝ 今日之後（含今日）最近的一個星期日**；那一期
   如果已經**真的寄過**（`SendLog` 有 `DRY_RUN` 不是 `TRUE`、`STATUS`
   是 `SENT` 的紀錄）就順延一週。
2. `Mailer.gs`／`Trigger.gs`／`QuarterResolve.gs`／`SelfTest.gs` S18
   全部改叫 `resolveNextSendSundayIso_()`，一個都不准自己算。
3. `SEND_TARGET_OFFSET_DAYS` **廢棄**：移出 `CONFIG_KEYS`／`DEFAULTS`，
   加入 `cleanupDeprecatedConfigKeys_()` 的清單。留一個沒有人讀的設定鍵
   在表上比刪掉更危險——有人改了它，以為改到寄送日期，其實什麼都沒有
   發生。
4. S18 的對照值改用一支**與被驗邏輯無關**的算法（直接數 `getDay()`）。
   `tests/sendschedule.test.js` 的預期值全部寫死，不由 sandbox 算。
5. 一條 grep 測試守住「不可以再有人讀 `SEND_TARGET_OFFSET_DAYS`」。

**「已寄過」的兩條界線**

- `DRY_RUN` 的紀錄**不算**已寄。試寄的用途正是「寄之前先看一次」，
  如果試寄會令系統跳過那一期，就變成試一次漏一期，而且完全沒有提示。
- `FAILED` 的紀錄**不算**已寄。寄失敗代表沒有寄到，下一次要再試同一期，
  不是跳過它。

**一般化**

- 一條算式如果依賴一個**沒有寫出來的前提**，它遲早會在前提不成立的
  呼叫方手上答錯。寫算式時問一句：「這條式在什麼情況下會錯？」答案如果
  是「今日不是星期一」，那就不要用天數，直接數星期幾。
- 名字講的是**意圖**，算式做的是**實作**。兩者對不上的時候，看的人會信
  名字。`targetIso = today + 6` 這種寫法要求讀者自己補上「因為今日是
  星期一」——補不到就以為它是對的。
- 「線上一直沒有出事」不等於算法正確，可能只代表**正式流程剛好滿足那個
  隱藏前提**。換一個入口、換一日跑，就會現形。
- 驗證的一方絕對不可以與被驗的一方共用算式。S18 捉到這個 bug，靠的是
  它另外用了一支獨立算法對照。

---

## 事故三十一：不變量假設了只有正式環境存在

**症狀**

第二輪自測：18 個情境，6 紅。**其中 5 個的原因是同一個。**

S13、S14、S15、S16、S17 全部紅，而那 5 個情境的「實際」欄**全部寫住
「符合」**——情境本身做對了，紅的是跑完之後那一次不變量檢查：

> `I06　PublishLog 最新一行的版本，對得上 master 檔案目前的內容`

**根本原因**

I06 的寫法是：

```js
var latest = latestPublishLogRow_(readSheet(SHEETS.PUBLISH_LOG));   // 最新一行
var config = publishConfig_();                                       // 正式 master
readMasterPdfBytes_(config.masterFileId)                             // 對正式那一個
```

它假設「`PublishLog` 最新一行 ＝ 正式 master 那一次發佈」。

自測機發佈的是**沙盒** master（`selfTestRunPublish_()` 會暫時把
`PUBLISHED_PDF_FILE_ID` 指去沙盒檔案，跑完還原）。所以 S13 一發佈完：

- `PublishLog` 最新一行是**沙盒**那一次；
- 指紋記錄（一個共用的 Script Property）也被沙盒那一次蓋走；
- I06 拿沙盒的版本／指紋，去對**正式** master 的內容。

必然對不上。而 I06 掛在「每個情境跑完都驗一次」的全域集合上，於是由 S13
起，**之後每一個情境都被染紅**。

⚠️ 兩層加起來才是完整的故事，跟事故二十七同一個形狀：
一條檢查本身有問題（引用了正式環境專用的設定），加上它掛在全域集合上，
於是**紅燈出現在不相干的地方**。看報告的人會以為六個功能壞了，實際只有
一條不變量要查。

**一般化的一句**

> **不變量假設了只有正式環境存在。**
> 一條不變量若引用任何「正式環境專用」的設定（master 檔案、正式季度、
> 正式收件人），在沙盒執行時就會必然失敗，並把本來通過的情境一併染紅。
> 每條不變量都要明確聲明它對哪一個環境成立，或者聲明「不適用」。

**修法**

1. `PublishLog` 加兩欄（一律加在最尾）：
   - `MASTER_FILE_ID`——這一次實際覆寫了哪一個檔案；
   - `IS_SELFTEST`——由自測機或亂行機產生的紀錄為 `TRUE`。

   `IS_SELFTEST` 刻意**由「覆寫的檔案 === `SELFTEST_MASTER_PDF_FILE_ID`」
   推出來**，不是靠呼叫方傳旗標。旗標會有人忘記傳，而忘記傳的後果正是
   這一次要修的東西。

2. 歷史資料一次性補寫：加欄之前的每一行都是正式發佈（自測機那時還未
   發佈過任何東西），所以 `MASTER_FILE_ID` 填 `PUBLISHED_PDF_FILE_ID` 的
   現值、`IS_SELFTEST` 填 `FALSE`。**只補空白的格**——重跑「初始化工作表」
   是常事，第二次跑不可以把真正的自測紀錄改成 `FALSE`。

3. 指紋改成**一個 master 檔案一份**（`PUBLISH_LAST_OUTPUT::<fileId>`）。
   舊版只有一個共用的鍵，沙盒發佈一次就把正式那一份蓋走，而且再也復原
   不到。舊鍵保留，但只在正式發佈時寫，而且讀的時候只可以當成正式那一邊
   的記錄。

4. I06 改為**逐條通道**判斷：正式一條、沙盒一條，各自對自己那一個檔案；
   某一條未發佈過或未設定就回「不適用」，**不是失敗**。去對哪一個檔案，
   一律看**該行自己的 `MASTER_FILE_ID`**，不靠 Config 猜——Config 是
   「現在指著哪一個」，發佈記錄是「當時寫了哪一個」，兩者不是同一件事。

5. 每一條不變量加一個**必填**的 `environment` 聲明（`ANY` /
   `PER_CHANNEL` / `PRODUCTION_ONLY`）加一句 `environmentNote` 寫明理由，
   並加一條靜態檢查：缺少或不合法就報錯。逐條檢視的結果見
   `docs/待確認事項.md` Q-2。

6. 自測機報告分三段：**情境本身失敗** / **情境通過，但不變量不成立** /
   **略過**。摘要那一行也分開數：
   `18 個情境，15 通過 1 失敗 2 不變量警告 0 略過`。

**為什麼「不變量警告」不併入紅、也不併入綠**

- 併入**紅**：一條不變量不成立會令它後面每一個情境一齊變紅，看報告的人
  會以為六個功能壞了，於是逐個去查——查五個沒有壞的東西。
- 併入**綠**：等於放過一個真的問題。不變量不成立就是系統進入了一個自相
  矛盾的狀態，一定要有人去看。

所以它是**第四種**結果，單獨數、單獨一段、而且那一段開頭就寫「先查那一
條不變量，不要逐個情境查」。

**一般化**

- 「這條檢查在**哪一個環境**成立」是一個**必須寫出來**的屬性，跟
  「有沒有副作用」同級（事故二十七）。漏寫與「檢視過、確認是任何環境都
  成立」在程式碼裡看起來一模一樣。
- 一個「記錄」如果推不出它當時作用在**哪一個對象**上，日後就只能靠猜。
  發佈記錄要記低「覆寫了哪一個檔案」，不可以靠讀 Config 反推——Config
  會變。
- 同一種資源如果有「正式」與「沙盒」兩份，**任何為它而設的快取／指紋／
  時間戳都要跟著分兩份**。共用一個鍵的話，沙盒那一次會靜靜蓋走正式那一
  份，而且復原不到。
- 修一條檢查之前先問：「它紅的地方，跟它壞的地方，是不是同一個？」不是
  的話，先修位置。

---

## 事故三十二：斷言指定了「用哪一道守門」，而不是「結果對不對」

**症狀**

第三輪自測 S14「連續發佈同一份兩次」報失敗。原始證據：

> 兩次之間相隔約 13 秒，`PUBLISH_DEDUP_SEC=30`；
> 第二次回覆：你選的是目前已發佈的那一份，請選用 Word 另存的新 PDF。

即是第二次發佈**確實被擋住了**，版本號維持 1，**行為完全正確**——只不過
是被 `UPLOAD_IS_CURRENT_MASTER` 那一道守門擋住，而不是 `PUBLISH_DEDUP_SEC`
那一道。情境只認後者，於是報失敗。

**系統沒有錯，錯的是斷言。**

**根本原因**

斷言寫成：

```js
var ok = second.ok === true && second.duplicate === true && versionAfter === versionBefore;
//                             ^^^^^^^^^^^^^^^^^^^^^^^^ 指定了「一定要防重複那一道」
```

`duplicate === true` 是**實作細節**（哪一道守門處理了它），不是**結果**
（有沒有被擋住、版本有沒有變）。系統有多過一道守門，換一道擋住是完全
合理的事——尤其當那一道排得更前、更早就乾淨拒絕。

⚠️ 這種假紅特別難查，因為證據欄裏面**明明白白寫住系統做對了**。查的人
第一反應會是「系統壞了」，然後去改一個沒有壞的東西。

**附帶發現：兩份「不同內容」的 PDF 其實一模一樣**

第二輪的 S14 用了「自測防重複甲」與「自測防重複乙」兩份 PDF，以為內容
不同。但 `selfTestMakePdfBlob_()` 會把**全部非 ASCII 字元換成 `?`**：

```js
String(text).replace(/[^\x20-\x7E]/g, '?')
```

於是兩份都變成 `????????`——位元組完全相同。所以第二次上載的其實是同一
份內容，被「揀錯檔案」那一道擋住是完全正確的。

要造出真的不同的內容，必須用 **ASCII** 分辨得出的文字。

**修法**

1. **S14** 改為斷言「第二次被擋住（**任何一道守門都算**）、版本號不變」，
   並在證據欄寫明**是哪一道**擋住的。新增 `describePublishBlock_()`：
   輸入一次發佈的結果，輸出 `{blocked, gate, gateLabel, message}`。
2. **新增 S14b**：視窗之內、用**真的不同**（ASCII）的內容再發佈同一個
   主日 → 斷言被防重複那一道擋住。這一條才可以指定 `gate === 'DEDUP'`，
   因為它的分工正正是驗那一道。
3. **新增 S14c**：視窗**之外**、內容不同 → 斷言**不擋**、版本 +1。
   只驗「擋得到」而不驗「不該擋的時候不擋」，等於只證明了它會擋，沒有
   證明它擋得準。
4. 四個情境（S13／S14／S14b／S14c）各自用**不同主日**——防重複的時間戳
   是逐個主日分開存的，用同一個主日的話，前一個情境留下的時間戳會令
   後一個的第一次發佈就被擋住。

**一般化的一句**

> **斷言指定了「用哪一道守門」，而不是「結果對不對」。**
> 系統換一道守門擋住，行為正確，測試卻報失敗。
> 斷言應該針對可觀察的結果（有沒有被擋、版本有沒有變），
> 至於是哪一道守門，記入證據，不寫進斷言。

**一般化**

- 斷言要問「**使用者看得見的結果**對不對」，不是「內部走了哪一條路」。
  走哪一條路屬於**證據**，記低就好，不要寫進判斷式。
- 一個系統有多過一道守門是**好事**。測試如果因此變紅，要改的是測試。
- 例外：如果某一道守門本身就是要驗的東西，那就另開一條專門驗它的情境
  （S14b），並在註解寫明「這一條的分工正正是驗那一道」。分工寫清楚，
  下一個人才知道哪一條可以指定守門、哪一條不可以。
- 造「兩份不同的測試資料」之前，先確認它們**真的不同**。經過任何正規化
  （去掉非 ASCII、trim、大小寫）之後才比較，是最容易出錯的一步。

---

## 事故三十三：一句「對不上」不是證據，是結論

**症狀**

第二輪修完之後，I06 仍然報：

> 預期 每一條通道都對得上，實際 **1 條通道對不上（正式）**

看完這句話之後，**仍然不知道要做什麼**：對不上的是版本號還是內容？兩邊
分別取自哪裏？master 檔案是不是被人手改過？全部答不出。

**先拿證據，再改邏輯**

所以這一輪先做的不是修 I06，是新增一個選單「診斷 I06（唯讀）」，把七項
事實全部打出來：最新一行的全部欄位、該行的 `MASTER_FILE_ID` 與 Config
現值、存檔副本的實況、master 檔案目前的位元組數／MD5／最後修改時間、
Drive 版本記錄、**I06 實際比對的是哪兩樣東西**、以及兩者差在哪裏。

⚠️ 七項**逐項都要有一行**。取不到的一項要明確寫「取不到，原因是⋯⋯」，
不可以整項消失——一項靜靜不見了，看報告的人會以為那一項沒有問題。

**根本原因（用診斷的思路逐字重現出來）**

第二輪把發佈指紋存在 Script Property。讀取時有一段**舊鍵退回**：

```js
// 第二輪的寫法
var legacy = parsePublishOutputFingerprint_(readPublishScriptProperty_(PUBLISH_LAST_OUTPUT_KEY_));
if (!legacy) return null;
if (legacy.masterFileId && legacy.masterFileId !== fileId) return null;  // ← 舊記錄沒有這一欄
return legacy;
```

當時寫的理由是：「加入這兩個鍵之前，全部發佈都是正式發佈（自測機那時還
未存在），所以舊記錄一定屬於正式檔案。」

**那個理由是錯的。** 第一輪的自測機**已經**會發佈沙盒 master，而那時只有
一個共用的鍵——所以舊記錄有可能是**沙盒那一次**寫的。

於是：I06 拿一份沙盒發佈的版本號（例如 `2028-10-01 第 4 版`），去對正式
那一行（例如 `2026-08-23 第 2 版`），版本對不上 → 報「1 條通道對不上
（正式）」。**那個紅是假的**，而且 master 檔案的內容根本沒有問題。

⚠️ 這一段推論不是靠估：用一個最小重現腳本，逐字重現出同一句
「1 條通道對不上（正式）」，然後才動手改。

**修法（診斷結果落在 prompt 的 C，remedy 用 B）**

1. **B**：`PublishLog` 加 `CONTENT_BYTES` 與 `CONTENT_MD5` 兩欄，發佈時
   **直接記在那一行上**。I06 優先用該行自己的指紋。共用的 Script Property
   會被下一次發佈蓋走（包括沙盒發佈），逐行記錄就沒有這個問題。
2. **C**：收緊舊鍵退回——**認不出屬於哪一個檔案的舊記錄，一律不採用**。
   寧可回「驗證不到」，也不可以報一個假的「不一致」。
3. **A**：如果 master 檔案的內容真的被人手覆寫過，提供選單
   「重新對齊 I06」把目前內容的指紋記回 `PublishLog`。
   ⚠️ 那是**承認現況**，不是修復：它不會碰 Drive 檔案，撳完 I06 會變綠，
   靠的是把記錄對齊現況。所以對話框要講清楚，並叫人先看診斷報告。
4. I06 不成立時，訊息要講**成因**（大小差幾多位元組、還是同樣大小但
   MD5 不同）、常見原因（有人手動上載覆寫）、以及**下一步**（撳診斷、
   確認之後撳重新對齊）。

**歷史資料為什麼不補 `CONTENT_MD5`**

補不到。加欄之前那幾次發佈的內容指紋，從任何現存資料都反推不出來——
存檔副本有機會被 Drive 重新編碼過，不等於 master 當時那一份。填一個
猜出來的值，等於把「不知道」記成「知道」。

所以舊行的 I06 會報「**驗證不到**」，並明講「下一次發佈之後，指紋會直接
記在該行上，這一條就會自己好返」。

**一般化**

- **一句「對不上」不是證據，是結論。** 報告要講得出「兩邊分別是什麼、
  分別取自哪裏、差在哪裏」，否則看的人只能靠猜。
- 修一條檢查之前，先寫一個**能夠逐字重現那個症狀**的最小例子。重現不到
  就代表還未明白，改下去只是碰運氣。
- 「這個假設在當時是成立的」要寫出**當時**是什麼時候，並且回去確認。
  第二輪那句「自測機那時還未存在」憑印象寫，而事實是它已經存在了一輪。
- 一份記錄如果**講不出自己屬於哪一個對象**，就不可以拿來當任何一個對象
  的記錄。寧可回「不知道」，也不要猜一個。
- 提供「把記錄對齊現況」這種動作時，要在對話框寫明它是**承認現況**而
  不是修復，並叫人先看證據——否則它會變成一個「令紅燈消失」的按鈕。

---

## 事故三十四：續跑用了沒有狀態的亂數，等於每次都是新的一輪

**症狀**

`MonkeyLog` 25 行紀錄。使用者撳了三次〔繼續亂行〕，得出的是：

| RUN_ID | 種子 | 步數 |
|---|---|---|
| MK20260825154132 | 922896898 | 1 至 9 |
| MK20260825155012 | 923417060 | 1 至 7 |
| MK20260825155516 | 923721813 | 1 至 9 |

每一次都是**新的 `RUN_ID`、新的種子、`STEP_NO` 由 1 數起**。目標 20 步
從來沒有跑滿過——而且完全沒有提示。

**根本原因**

`menuResumeMonkey_()` 做的事，與〔跑亂行機〕一模一樣：

```js
var summary = runMonkey_({ steps: ... });   // 沒有 resume、沒有種子、沒有狀態
```

它連「上一次跑到哪裏」都沒有存過。當時的註解甚至寫明了這個設計：

> 「繼續」的意思是「由目前狀態再走 N 步」，不是「重播上一次那條路」。

那句話本身沒有錯，但它混淆了兩件事：

- **重播**（replay）：由乾淨狀態、同一個種子，走同一條路。
- **續跑**（resume）：接住上一次未跑完那一輪，`STEP_NO` 接上去、
  **亂數接住抽**，最後走出來的整條路與「一次過跑滿」完全相同。

第二件事是做得到的，而且正是使用者以為自己在做的事。做不到的只是第一件。

**為什麼「存種子」不夠**

種子只講得出「由哪裏開始」。續跑要的是「**走到哪裏**」。由種子重新開始，
等於重播頭 N 步，不是接住走——第 1 批走的路會在第 2 批再走一次。

所以要存的是**亂數產生器的內部狀態**（`RNG_STATE`）。而
`Math.random()` 拿不到內部狀態，所以它連「可以續跑」這個選項都沒有。

**修法**

1. 新增 `MonkeyState` 工作表：`RUN_ID`、`SEED`、`TARGET_STEPS`、
   `STEPS_DONE`、`RNG_STATE`、`STATUS`（`PAUSED`／`DONE`）、時間、備註。
   ⚠️ `SEED` 與 `RNG_STATE` 登記為**純文字欄**——32 位元整數當成數字存
   會被試算表改寫成科學記數法，續跑就還原不到（事故二十八）。
2. `runMonkey_({resume:true})`：讀最後一行，如果是 `PAUSED` 就沿用同一個
   `RUN_ID`、同一個種子、還原 `RNG_STATE`，由 `STEPS_DONE + 1` 繼續。
3. 沒有 `PAUSED` 紀錄 → **明確拒絕**並指路去〔跑亂行機〕，
   ⚠️ 不可以靜靜開新一輪。
4. ⚠️ 只看**最後一行**。最後一行如果已經 `DONE`，就是沒有東西可以接——
   不可以往上找一個更舊的 `PAUSED`，那一輪的沙盒狀態早就被後來那一輪
   改過了。
5. 摘要顯示**累計**：`走了 14／20 步（本批 5 步）`，並顯示 `RUN_ID`
   與種子。只顯示本批步數的話，續跑三次每次都寫「走了 9 步」，看的人
   完全不知道目標從來沒有跑滿過。
6. 跑滿目標 → `STATUS='DONE'`，摘要寫「已完成 20／20 步」。

**測試怎樣才驗得到**

自我檢驗是：**同一個種子由頭跑滿 20 步，與分三批續跑到 20 步，揀中的
動作序列必須完全相同。**

⚠️ 這一條測試很容易寫成恆真：如果「分批」那一邊其實叫了三次新一輪，
兩邊都會走同一條路（因為每次都由頭開始），測試照樣綠。所以還要一條
**反向**測試：把 `RNG_STATE` 寫成「由頭開始的狀態」（即是舊版那種只存
種子的做法），序列必須**接不上**——證明上面那一條真的測得到分別。

**一般化**

- 「續跑」與「重播」是兩件事。講「繼續」之前先問：接住的是**進度**，
  還是重走**同一條路**？兩者要的東西不同。
- 任何「可以分批做」的流程，都要存**做到哪裏**，而不是只存「由哪裏
  開始」。存起點只夠重來一次。
- 用一個**拿不到內部狀態**的亂數產生器，等於放棄了續跑這個選項。
  這不是「將來再優化」，是當下就做不到。
- 進度要顯示**累計**。只顯示本批的話，一個「從來沒有跑完過」的流程
  看起來每次都很成功。
- 寫「兩種做法結果相同」這類等價測試時，一定要另外寫一條**反向**測試，
  證明做法不同時它真的會紅——否則那條等價測試有機會恆真。

---

## 事故三十五：`% n` 取亂數的低位元——看起來平均，其實是一個固定循環

**症狀**

亂行機跑了 25 步，八個動作之中有**四個**幾乎沒有被揀過：
`PUBLISH` 零次、`WRITE_CONTENT` 零次、`RESEQUENCE` 零次、
`IMPORT_CONTENT` 只有一次。

25 步之中某一個動作零次被揀，若是均勻隨機，機率約 3.5%；三個動作同時
零次，機率低於千分之一。

**根本原因**

亂數產生器是模 2^32 的線性同餘（LCG）：

```js
state = (1664525 * state + 1013904223) % 4294967296;
return state % bound;                                  // ← 問題在這一句
```

模 2 的冪的 LCG，有一個教科書級的弱點：**低位元的週期極短**——低 k 個
位元的週期只有 2^k。而 `% bound` 取的正正是低位元。

實測（種子 922896898）：

```
nextInt(2) → 1,0,1,0,1,0,1,0…       完全交替
nextInt(4) → 1,0,3,2,1,0,3,2…       週期 4
nextInt(8) → 1,4,3,6,5,0,7,2,1,4…   週期 8，永遠這個循環
```

八個候選動作的時候，「隨機揀一個」其實是一個**固定的八循環**。

更差的是：種子取自時間戳記（`new Date().getTime() % 2^32`），連續幾次
執行的種子只差幾百。三次「不同」的執行，其實只是同一個循環的**旋轉**：

```
922896898 → 1,4,3,6,5,0,7,2…
923417060 → 3,6,5,0,7,2,1,4…    同一個循環，起點不同
923721813 → 0,7,2,1,4,3,6,5…
```

至於為甚麼有些動作仍然零次：動作內部也會抽亂數（揀主日、揀改幾多格），
每一步消耗的次數不固定，於是那個固定循環被切成不均勻的片段，長期只落在
其中幾個索引上。

**⚠️ 為甚麼「數分佈」驗不出來**

數 100000 次 `nextInt(8)`，八個值各 12500 次，**完美平均**。

因為那是一個**排列循環**——長期次數當然平均，問題出在**序列**。
所以驗的時候要驗序列（有沒有固定週期、相近的種子是不是旋轉關係），
不是驗次數。

**修法**

1. 換成 **mulberry32**：有雪崩效應，低位元不再有短週期。
2. `nextInt()` 改用**高位元**：`Math.floor(v / 2^32 * bound)`，
   不用 `v % bound`。
3. 順帶：mulberry32 的內部狀態是一個 32 位元整數，存得低、還原得返——
   續跑（事故三十四）也靠它。

實測修正後：同樣「8 個候選、25 步」的模擬，平均每次執行有 **0.29** 個
動作零次被揀中（舊版實測是 3 個）。

**還要做的兩件事（因為零次被揀中不一定是亂數的錯）**

- **候選清單要誠實**：不合法的動作要記低**原因**，不可以靜靜由候選清單
  剔走。零次被揀中的動作，究竟是「有資格但抽不中」還是「根本沒有資格」，
  是兩件事，報告要分開講。
- **覆蓋統計**：報告最後列出每個動作被揀中幾多次，零次的**明確標出**。
  不標的話，一個從來沒有跑過的動作，看起來與「跑過而且沒事」一模一樣。

**一般化**

- `随機值 % n` 是一個陷阱：它取的是低位元，而很多產生器的低位元品質
  遠差過高位元。要取範圍，用 `floor(value / 2^bits * n)`。
- 驗亂數品質要驗**序列**（週期、相鄰種子的相關性），不是驗**次數分佈**。
  一個固定的排列循環，次數分佈是完美的。
- 種子取自時間戳記的話，連續幾次執行的種子高度相關。產生器如果對種子
  不夠敏感，幾次「不同」的執行會走同一條路。
- 「某個選項從來沒有被抽中過」要當成**訊號**去查，不要當成巧合。算一算
  機率：低於千分之一就幾乎肯定不是運氣問題。

---

## 事故三十六：Script Property 不可以做真相來源——它會被清、會遺失

**症狀**

第三輪把發佈指紋存在 Script Property。實測「診斷 I06」的結果：

```
存檔副本（1BpoltWy…）指紋：2007999:6e3f926ae46694a2699b47fc04311d8a
master 檔案（1gT9Z97V…）指紋：2007999:6e3f926ae46694a2699b47fc04311d8a
→ 完全相同，內容沒有問題

PublishLog 該行 CONTENT_BYTES：（空）
PublishLog 該行 CONTENT_MD5：（空）
I06 左邊讀的是 Script Property PUBLISH_LAST_OUTPUT::1gT9Z97V…：（沒有記錄）
```

**內容根本沒有問題**——存檔副本與 master 的指紋一個字元都不差。紅的原因是
「取不到」被當成「對不上」。

**根本原因（兩層）**

第一層：Script Property **不是**一個可靠的真相來源。

- 它是全 script 共用的一個袋，任何一次寫入都會蓋走同名的鍵；
- 它會被 Apps Script 環境清走（重新部署、專案設定改動、配額）；
- 它與那一行發佈紀錄**沒有任何綁定關係**——兩者可以各自存在、各自消失。

第二層（更重要）：**「取不到」被當成「對不上」**。這是本專案反覆犯的
同一種錯（`docs/已知bug類型.md` 第 2 類、事故三十三）。一個讀不到的來源，
應該報「驗證不到」，不是報「不一致」。

**修法**

I06 的比對來源改成三步，**完全不讀 Script Property**：

1. `PublishLog` 該行的 `CONTENT_MD5` ＋ `CONTENT_BYTES`（發佈時即時寫入）；
2. 空的話 → 該行 `ARCHIVE_FILE_ID` 那一份**存檔副本**的實際指紋；
3. 兩者都取不到 → 報「驗證不到」，並講明**是哪一邊**取不到。

⚠️ 第 2 步是一個**有前提的推斷**：存檔副本是發佈那一刻由同一個 blob 存出
來的，所以理論上與 master 相同（實測那一次完全一樣）。但它畢竟是另一個
檔案，所以報告一定要講明「指紋來自存檔副本」，不可以扮成發佈當時直接記
下的值。

Script Property 那條路整條移除（`PUBLISH_LAST_OUTPUT` 那個鍵、四個相關
函式），並加一條靜態檢查：`src/` 不可以再出現那幾個名。

**一般化**

- 一份記錄如果與它描述的那一行**沒有綁定關係**，它遲早會對不上。要記
  「這一行發佈了什麼」，就記在**那一行上**。
- Script Property／快取／全域變數，可以做**加速**，不可以做**真相**。
  判斷準則很簡單：「它不見了，我還答得出這個問題嗎？」答不出就不是真相
  來源。
- 「取不到」與「對不上」永遠是兩種結果。搞混的代價是：查的人去修一個
  沒有壞的東西（這一次是 master 檔案的內容，而它完全正常）。
- 退而求其次的來源（這裡是存檔副本）要**講明是退而求其次**。不講的話，
  下一個人會以為那是第一手的記錄。

---

## 事故三十七：程式碼寫 v2 的欄位名，服務釘死在 v3——而假替身也模仿 v2，於是兩邊一齊錯

**症狀**

「診斷 I06」的第 5 項（Drive 版本記錄）永遠讀不到：

```
讀不到版本記錄：API call to drive.revisions.list failed with error:
Invalid field selection items
```

**根本原因**

`appsscript.json` 把 Drive 進階服務釘死在 **v3**：

```json
{ "userSymbol": "Drive", "serviceId": "drive", "version": "v3" }
```

但程式碼寫的是 **v2** 的欄位名。而且**不只版本記錄那一處**——查下去發現
整批都是：

| 位置 | 寫了 v2 | v3 應該是 |
|---|---|---|
| `driveCountRevisions_` | `items(id)`、`maxResults` | `revisions(id)`、`pageSize` |
| `driveListRevisions_` | `items(…)`、`modifiedDate`、`fileSize`、`lastModifyingUserName` | `revisions(…)`、`modifiedTime`、`size`、`lastModifyingUser`（**物件**） |
| `driveCountFilesByNameInFolder_` | `q: title = '…'`、`maxResults`、`items(id)` | `name = '…'`、`pageSize`、`files(id)` |
| `probeDriveAdvancedService_` | `maxResults`、`items(id)` | `pageSize`、`files(id)` |
| `driveUpdateFileContent_` | 檔名欄位用 `title` | 檔名欄位用 `name` |

最後那一個的註解甚至寫住「Drive 進階服務喺本專案釘死喺 **v2**（見
appsscript.json）」——**註解與 appsscript.json 對不上**，而且沒有人發現，
因為 v3 會靜靜忽略 `title`：內容照樣覆寫得到，只是「順手改檔名」那一步
一直沒有生效。

**為什麼一直沒有人發現**

因為**假替身也模仿 v2**：

```js
// 舊版 tests/helpers/fakeDrive.js
const nameKey = "title = '";
…
return { items: items };
```

`src/` 那一邊錯，測試替身那一邊用同一個錯的假設 —— 兩邊**一齊錯**，於是
測試全部綠，而真環境每一次呼叫都失敗。這正是事故二十二那一句：
**驗證函式與被驗證的邏輯用同一個假設，等於沒有驗證。**

而且那幾個呼叫全部包住 `try/catch` 回 `null`／`-1`／`ok:false`，所以錯誤
被吞成「數不到」「讀不到」——I10 一直報「驗證不到」，而沒有人去追那句
「驗證不到」背後的原因。

**修法**

1. 全部呼叫改用 v3 欄位名。
2. **假替身收到 v2 欄位名就拋錯**——這一步比改 `src/` 更重要：它令這一類
   錯誤在測試就撞到，而不是等真環境。
3. `Drive.Revisions.list` 一律帶 `supportsAllDrives`（master 在 Shared
   Drive 上）。舊註解寫「刻意不加，怕 API 不認識這個參數」——實測推翻了
   那個顧慮：真實環境回的錯只提 `fields`，完全沒有提 `supportsAllDrives`。
4. 新增選單「發佈版本記錄（唯讀）」，把每一個版本的時間、大小、修改者列
   出來，並寫明還原步驟。

**一般化**

- 版本號寫在設定檔，欄位名寫在程式碼——**兩者會分家**。改版本的時候，
  要 grep 全部欄位名，不是只改設定檔那一行。
- 註解講的版本如果與設定檔不符，**信設定檔**，並即刻修好註解。這一次那句
  錯註解令「檔名沒有改到」這件事多活了幾輪。
- 假替身要模仿**真實 API 的嚴格程度**。一個「什麼都收」的假替身，會令
  一整類參數錯誤在測試裡完全隱形。做得到的話，讓它在收到錯誤形狀時
  **拋錯**。
- `try/catch` 回 `null` 是對的（三個狀態），但「驗證不到」出現得太頻繁
  就是一個訊號——要去追那句「讀不到」背後的原因，不可以長期當成正常。

---

## 事故三十八：跨批的狀態存了一半——亂數接得上，走過的路接不上

**症狀**

`MonkeyLog` 的證據：

| 步 | 路徑欄的值 |
|---|---|
| 17 | 寄出（試行） → 在內容表寫幾條家事報告 |
| 18 | 寄出（試行） → 在內容表寫幾條家事報告 → 寄出（試行） |
| 19 | **整理清單次序** |
| 20 | **寄出（試行）** |

第 19、20 步的「走到這裏的完整步驟」重置了。

**根本原因**

上一輪修好了續跑：`RUN_ID`、種子、`RNG_STATE` 全部存進 `MonkeyState`，
所以**亂數**接得上。但「走過的路」仍然是一個 local 陣列：

```js
var pathSoFar = [];        // 每一次 runMonkey_() 都由空開始
```

於是每一批都由空開始。第 19、20 步各自是一個只走得到一步的批次（時間
預算逼停），所以路徑各自只有一個動作。

⚠️ **修了一半比沒有修更難查**：續跑「看起來」是好的（`RUN_ID` 一樣、
步數接得上），只有那一欄不對，而那一欄正是亂行機最重要的輸出。

**修法**

1. `MonkeyState` 加 `PATH_SO_FAR` 欄，存**精簡格式**
   （`1:CREATE_WEEKS,2:EDIT_FIELDS,…`）；
2. 續跑時解回來，接住走；
3. 太長的時候改用精簡格式顯示，**不可以截斷開頭**——「走到這裏的完整
   步驟」的價值全在「由第 1 步開始」。真的連精簡格式都爆格才截**尾**，
   而且要明寫截了幾多步。

⚠️ 存精簡格式而不是中文標籤：標籤長得多，20 步已經幾百字。精簡格式帶住
**步數**，所以解回來之後仍然講得出第幾步做了什麼。

**一般化**

- 「可以分批做」的流程，要列出**全部**跨批要保存的狀態，逐項確認存了。
  存了一半的狀態，比完全沒有存更難查——因為表面上它是work的。
- 改一個「續跑」功能之後，問一句：「這一輪之內**每一個**會累積的東西，
  是不是都接得上？」不要只驗最明顯那一個。
- 截斷長字串時，先問「哪一頭比較重要」。開頭通常比結尾重要（那是怎樣
  走到這個狀態的），所以截尾。而且一定要明寫截斷了。

---

## 事故三十九：用時間視窗去圈「一批」，兩次操作靠得近就會被併埋

**症狀**

同一輪亂行之中，第 17 步通過、第 18 及 19 步 `I04` 不成立、第 20 步又
自己通過。

**根本原因**

I04 要驗「寄出前預覽的收件人數 === 實際寄出的封數」，所以它要圈得出
「最近**一次**寄出寫了哪幾行」。舊版是用**時間視窗**圈的：

```js
var INVARIANT_SEND_BATCH_MS_ = 90000;   // 90 秒
```

由最後一行往上數，狀態相同、時間相差不超過 90 秒的都算同一批。

亂行機每一步只需幾秒。第 16 步寄一次（3 封）、第 18 步再寄一次（3 封），
兩次相隔 20 秒 → 被併成一批 → `loggedCount` 是 6、`previewCount` 是 3 →
報「預覽講的與實際做的不是同一件事」。

第 19 步沒有再寄，最近一批仍然是那 6 行 → 照樣紅。
第 20 步又寄一次，這一次與前一次相隔超過 90 秒 → 只圈到 3 行 → 又綠了。

**逐字重現過**：

```
兩次寄出相隔 5 秒  → 圈到 6 行（⚠️ 兩次被併成一批）
兩次寄出相隔 20 秒 → 圈到 6 行（⚠️ 兩次被併成一批）
兩次寄出相隔 60 秒 → 圈到 6 行（⚠️ 兩次被併成一批）
兩次寄出相隔 95 秒 → 圈到 3 行（正確）
```

**這是 I04 自己的問題，不是寄送的問題。** 系統每一次都寄對了封數。

**修法**

`SendLog` 加 `BATCH_ID`（最尾一欄）：同一次寄出寫入的每一行共用一個編號。
全部寄送流程一律經 `writeSendLogRows_()`，由它蓋章。I04 有編號就用編號圈，
不再靠時間猜。

舊資料沒有編號，仍然退回時間視窗——但 I04 的證據要**講明用了哪一條路**，
以及那條路會把靠得近的兩次寄出併埋。

另外：`MonkeyLog` 的「不變量狀態」欄，不成立時要寫齊
`{expected, actual, evidence}`，不可以只寫「不成立：I04」。只寫編號的話，
看的人要重跑一次才知道差在哪裏——而亂行機那一條路多數重現不到。

**一般化**

- 「同一批」「同一次」「同一組」這種概念，要靠一個**明確的編號**去圈，
  不可以靠時間相近去猜。時間視窗一定會有兩種錯：太窄會拆散一批，太闊
  會併埋兩批——而且兩種錯都只在特定節奏下出現。
- 一個間歇性的紅燈（有時紅有時綠），十次有九次是**判斷條件本身不確定**，
  不是被驗那件事有問題。先問「這個判斷條件依賴什麼？那樣東西穩定嗎？」
- 紀錄一個失敗，要記齊「預期／實際／證據」。只記一個編號，等於叫下一個
  人自己重現——而隨機路徑多數重現不到。

---

## 事故四十：把「還未到時候」當成「出錯」，整條流程停在那裏

**症狀**

`ErrorLog` 有一筆 2026-08-24 的實際紀錄：

```
TRIGGER | weeklyBulletinSendTrigger_ | ROSTER_NOT_FOUND |
sendBulletinForDate_：2026-08-30 這個主日在職事表找不到資料，無法寄送。
```

那一週的週報**沒有寄出**。同一個原因之下，「建立本季週報」也完全建立
不到——按下去只得一句「職事表找不到這一季」，一行都沒有建。

**根本原因**

職事表由另一個人維護，經常在季度開始前一兩個星期才建立好。系統把「職事表
還未有這一季」寫成 `throw new Error(...)`，於是：

- 「建立本季週報」整個中止。但那一季的**主日日期由曆法就推算得到**，
  事奉以外的欄位（講題、經文、詩歌、人數、家事報告）跟職事表完全無關，
  幹事本來可以先填那些。系統把它們一併擋住了。
- 星期一觸發器直接停止。但一份**只欠事奉名單**的週報仍然有用——會眾要
  知道講題、經文、詩歌、聚會時間。

**要點：「取不到」有兩種，一種是壞了，一種是未到時候。**
兩者的正確反應完全相反：壞了要停下來叫人看；未到時候要照樣做下去，並且
講明欠什麼、什麼時候補得到、怎樣補。把後者當成前者，代價是整條流程停擺，
而且停得毫無道理——沒有人做錯任何事。

**修法（R-036）**

1. `BulletinWeeks` 加一欄 `ROSTER_STATUS`（`OK`／`NOT_FOUND`／`PARTIAL`），
   把「這一個主日的事奉資料到底有沒有」變成**看得見的狀態**，而不是一個
   會令流程中止的例外。
2. 建立週報時職事表讀不到 → 改用曆法推算主日，照樣建立全部行，事奉欄位
   留空，對話框講明。
3. 新增「從職事表補抓」：**只填空白格**，所以隨時可以重試、撳幾多次都不會
   改壞東西。「可以安全地重試」是這一類「未到時候」功能的必要條件——
   不能重試的話，幹事就只能等到職事表齊了才敢開始，等於沒有修。
4. 星期一觸發器照樣寄出，信首加一句「本期事奉資料尚未確定」。這一種**不再
   寫 `ErrorLog`**，改記在 `SendLog` 的備註欄並標明「（不是錯誤）」——
   `ErrorLog` 裏面每一行都應該是真的有人做錯了什麼。
5. 填寫介面出**黃色**橫幅，不是紅色。

⚠️ 職事表仍然是**唯讀**。這一條只改「讀不到的時候怎麼辦」，一格都沒有寫
回職事表。

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
11. **系統自己組出來、要 `setValues()` 整批寫入的文字，
    沒有經過公式跳脫。** `setValues()` 不是使用者手動打字，沒有「這一格
    是純文字」這道防線；字串剛好以 `=`／`+`／`-`／`@` 開頭就會被 Sheets
    當成公式求值。凡是系統自己組字串（尤其是報告標題、狀態摘要）要寫
    進 `Diagnostics`／`AuditLog`／`SendLog` 這類表，一律要先經
    `sanitizeCellText_()`，而且組字串時也不要一開始就選會觸發這個問題
    的寫法（例如用 `'==='` 當分隔線）。
12. **同一個狀態，在不同程式路徑各自發明一套正規化／比較
    邏輯。** 兩條路徑要判斷「是不是同一個狀態」時（例如「從未儲存」、
    「兩個時間點是否相同」），如果各自寫一套看起來合理的判斷，只要
    其中一邊的型別或精度稍有落差，就會被判定不相符——而且往往是靜靜
    發生，錯誤訊息還會誤導成「有人改過」。**同一個狀態的正規化邏輯只
    准存在一份**，所有會用到的路徑都呼叫同一個函式，不可以各自重寫。
13. **例外被接住變成 `{ok:false,...}` 之後，就再也沒有
    留下任何痕跡。** Apps Script 的執行紀錄只看得到「這次呼叫完成」，
    看不出裡面其實是失敗的；前端的例外更是完全沒有人看得到。任何會把
    例外「吞掉」再轉成一個正常回傳值的地方（`try/catch` 接住之後回傳
    `{ok:false}`、`withFailureHandler` 之類），都要先把例外寫進看得到
    的地方（例如 `ErrorLog`）才繼續，而且「寫記錄」本身失敗時不可以
    連原本要回報的錯誤都一起弄丟。
14. **（本次新增）顯示一則訊息之後，緊接著呼叫另一個會清掉訊息的
    動作。** 任何「先給使用者回饋、再刷新畫面」的流程，如果刷新畫面
    的函式開頭就清訊息，回饋會在使用者看清楚之前消失，等於沒有回饋。
    寫這類流程時要主動問「這個訊息會不會被我緊接著呼叫的下一個函式
    清掉？」，需要的話讓下一個函式可以選擇性保留訊息。另外，「現在
    能不能操作介面」這種跨多個動作共用的狀態，要有**單一**顯示函式
    統一決定，不要讓每個呼叫點各自決定，否則會出現「這裡忘了停用」
    「那裡忘了恢復」這類顧此失彼的落差。
15. **（第七輪新增）以為「畫面上看得到的一串字」在底層也是一串
    字。** `.docx` 的一段文字是切成一個個 `<w:r>` 存的，Word 會在任意
    位置切開；HTML／XML 的文字節點同理。凡是要在這類格式上做字串比對
    或替換，一定要先把底層結構正規化（合併相鄰同格式節點），**而且要
    有機制偵測「正規化之後仍然對不上」並報出來**，不可以靜靜略過——
    那種失敗不會拋錯，只會在成品上原樣留下，要印出來才發現。
16. **（第七輪新增）多趟處理之下，前一趟填進去的資料被後一趟當成
    範本再處理一次。** 任何「先填一部分、再填另一部分」的渲染流程，
    都要問「第一趟填進去的值，會不會剛好長得像第二趟要找的東西？」
    使用者填的內容完全可能含有佔位符語法。做法是在**值注入的唯一
    出口**把語法字元中和掉（例如換成數值字元參照），原則是
    **值一律只當資料，永不當程式碼**。
17. **（第七輪新增）把底層例外的 `message` 原樣接在自己組的訊息
    後面。** 自己那一段小心翼翼把 ID 遮罩了，底層例外的訊息卻常常
    含完整 ID／路徑／電郵，一接上去遮罩就完全白做。凡是要把
    `err.message` 放進會流到記錄或畫面的字串，先把敏感值由那段訊息
    裡面**洗走**（見 `src/DocxIo.gs` 的 `scrubFileId_()`）。
18. **（第八輪新增）用兩個值去判斷一個需要三個值才答得到的問題。**
    「兩邊現值不同」本身沒有資訊量——要判斷的是「自從上次一致之後，
    是哪一邊變過」，那一定要有第三個值（上次一致時的基準）。凡是雙向
    同步、覆寫、衝突偵測，都要問「我手上有沒有基準值？沒有的話我是在
    猜」。已經中過兩次（第六輪職事表覆寫、第八輪季度填寫表），兩次的
    修法都是同一個：**把基準值存起來，做三方比較**。
19. **（第八輪新增）「令兩邊一致」的動作只更新其中一邊。** 快照／基準
    值的語意是「兩邊都同意的那個值」。只把基準推到新值、而另一邊仍然
    停在舊值的話，那個語意就被破壞了——下一次比對會把**根本沒有人改過
    的舊值**當成一個改動。更新基準的時候要問：「我有沒有令兩邊真的
    一致？」
20. **（第八輪新增）序列化之後型別悄悄變了。** `JSON.stringify()` 會把
    `Date` 變成字串、把 `undefined` 整個丟掉、把 `NaN` 變成 `null`。
    存進去再讀出來的資料**不等於**原本的資料。凡是要序列化再還原的
    地方（備份、快取、跨頁面傳值），先把值正規化成穩定的字串形式，
    而且要有一個「存了再讀出來，內容一字不差」的測試——這類 bug 不會
    拋錯，只會在真正需要那份資料的時候安靜地失敗。
21. **（prompt8b 新增）「預設值等於什麼都不做」的介面。** 使用者撳完
    確定沒有任何反應、系統又不留記錄，會被當成程式壞掉——跟真的壞了
    完全分不出來。凡是破壞性或不可逆的選擇（例如「暫不處理」／
    「略過」／「跳過」這類選項），都**不可以有預設值**；要嘛強制使用者
    明確選過，要嘛系統無論結果如何都留下一筆看得到的記錄。
22. **（prompt8b 新增）刪 Config 鍵之前一定要確認沒有值，否則等於
    靜靜丟掉使用者的設定。** `Config` 是人手編輯的工作表，一個鍵就算
    程式碼已經沒有引用，也可能被 Ivan 填過真實的值。清理廢棄鍵的程式
    碼一律要先讀值、只在**值為空**時才刪，值不為空時保留並產生警告，
    交由人手確認之後才手動刪除——絕對不可以「反正沒人用了」就無條件
    整批刪除。
23. **（prompt8b 新增）把已經編碼好的值，用會再轉義一次的樣板輸出
    標籤印出來。** `HtmlService` 有兩種輸出標籤：一種會把值當成要
    顯示的文字做 HTML 轉義，另一種原樣輸出、不轉義。凡是伺服器端已經
    呼叫過 `JSON.stringify()`（或任何其他編碼）產生的值，一律要用
    **不轉義**那一種——用會轉義那一種等於把編碼好的內容再轉義一次，
    引號、跳脫字元全部變成資料本身的一部分，而且**不會拋任何錯誤**，
    只會在下游比對／查表時全部落空。同一個檔案裡兩種標籤混用尤其
    危險，容易漏改其中一處。凡是收到這類外部輸入的伺服器端 API，也要
    在自己那一層做第二重防線（剝雜訊、驗格式、不合格式就明確拋錯），
    不要假設前端一定會把值傳乾淨。
24. **（prompt9 新增）程式碼第一次用到新的 Google 服務，忘記同步更新
    `appsscript.json` 的 `oauthScopes`。** 沒有明確列出範圍時，Apps
    Script 用「自動掃描推斷」，既有授權不會因為推斷出的範圍變大就主動
    要求重新授權，使用者要到真正呼叫那個服務時才會撞到一個看起來像
    伺服器錯誤、其實是授權不足的訊息。**任何 PR／輪次只要新增了呼叫
    `DriveApp`／`MailApp`／`ScriptApp` 等新服務的程式碼，都要同時檢查
    `oauthScopes` 有沒有列齊**，並提醒使用者這次部署後需要重新授權
    一次。
25. **（prompt9 新增）`tools/lint-readonly-roster.js` 的
    `DriveApp` 檢查是單純的字串比對，會被識別碼名稱裡剛好包含
    「DriveApp」四個字連續出現而誤判。** 幫 Drive 相關的輔助函式、
    變數、字串標籤命名時，要刻意避開讓「Drive」跟緊接的「App」連在
    一起（例如 `probeDriveAccess_` 而不是 `probeDriveAppAccess_`），
    不只是這一個 lint 規則的問題——任何用簡單字串比對做邊界檢查的
    工具，都要在動筆前搜一下新名稱會不會意外含有被禁的關鍵字組合。
26. **（prompt9 新增）Google 服務對輸入格式有隱性要求時（例如
    `Utilities.unzip()` 只認內容類型字串，不管位元組實際內容），
    假替身如果比真實服務寬鬆，會讓這一類 bug 一直漏到真實環境才發現。**
    第一次用到某個外部服務的方法時，花時間查一下它對輸入有沒有這種
    「看起來合理其實很嚴格」的隱性要求，讓假替身**至少一樣嚴格**——
    寧可假替身太兇、逼自己在測試裡先修好，也不要假替身太鬆放過真正的
    問題。
27. **（prompt9 補漏新增）用 `indexOf(prefix) === 0` 判斷一組互相是
    字首延伸的多字元前綴（例如 `#EACH:` 與 `#EACHP:`）時，比對次序
    一定要由長到短。** 短前綴排在前面，長前綴的輸入永遠會在短前綴那一
    關就比對失敗（字元對不齊），根本輪不到自己的分支——而且失敗的方式
    是靜靜落到預設分支，不會有任何錯誤訊息。幫這種「互斥前綴」寫分類
    測試時，也要把程式碼裡實際存在的每一個分支逐一對照著寫，不要憑
    印象數「應該有幾種」，見事故十九。
28. **只有一條推算路徑、沒有退回機制，遇到資料缺口就整個算不到。**
    「由這一刻的日期反推某個業務狀態」（例如「本季是哪一季」）這種
    推算，不能假設「現在」永遠找得到對應的資料——資料可能因為年度
    交接、遷移期、測試環境等原因暫時缺一段。凡是這類推算，都要設計
    成**有明確次序的多層退回**，每一層失敗都要留一句人看得懂的原因，
    不可以直接回 `null`／空字串就沒有下文；而且**同一個業務狀態只准
    有一個推算函式**，其他任何地方需要同一個答案都要呼叫它，不可以
    各自重新猜一次——猜的規則一旦之後改動，沒有同步改到的地方就會
    悄悄報出不一致的答案，見事故二十。
29. **固定上限的輸出區裡，數目有限的結論跟長度不受控的明細混在同一個
    序列，交給通用截斷機制處理。** 通用截斷只認「第幾行」，不知道
    「這一行重不重要」；明細的長度隨資料量成長沒有上限，一旦超過某個
    規模，會把排在後面、數目原本固定的結論擠出截斷範圍。凡是要同時
    輸出「結論」與「明細」到同一個有行數上限的地方，一律要**先為結論
    保留額度、結論保證完整寫入**，明細用剩餘額度寫、放不下就截斷並
    指路到查看完整明細的地方；明細本身也要有自己的上限，不能指望外層
    的通用截斷機制去公平分配，見事故二十一。
30. **驗證函式與被驗證的邏輯用同一個假設，等於沒有驗證。**
    用「我做咗幾多」（替換數、成功數）倒推「做得啱唔啱」，永遠捉唔到
    「我根本冇處理過」嗰一批。驗證一定要**由產出物出發**——重新讀返
    產出、用一條同產生過程冇共用假設嘅路徑實掃一次——唔可以由過程嘅
    記帳出發。同樣道理：如果幾個指標各有各嘅盲點，要主動問一句「有冇
    一種情況會啱啱好跌落全部盲點之間」，因為嗰種情況出現時，全部指標會
    **一齊報冇事**，比完全冇驗證更危險。另外，「驗證不到」同「驗證過、
    冇問題」必須用唔同嘅值表示（例如 `-1` vs `0`），唔可以蒙混成同一個，
    見事故二十二。
31. **一次操作有幾個步驟，其中一步失敗就一律回「失敗」。**
    判斷準則不是「有沒有拋錯」，而是「這一步失敗之後，外面的世界有沒有
    已經被改變」。已經改變了還回「失敗」，等於講一句與事實相反的話，
    使用者會據此做出錯誤的補救動作（重試、重新發佈、再寄一次）。
    寫 `catch` 之前逐步問一次；同一個操作內，不同步驟的失敗結論可以是
    **相反**的，要分開幾個 `try`，見事故二十三。
32. **把驗證排在動手之後。** 凡是可以乾淨拒絕的檢查（格式、大小、
    前置條件、要不要人手確認），一律排在任何外部寫入之前——那一段
    失敗才有辦法保證「一格都沒有寫」。排在後面的話，就會落入第 31 條
    那種「已經改變了卻要回失敗」的處境。
33. **只在前端擋。** 前端擋一次是為了少走一趟冤枉路，不是把關。
    真正的把關一定要在後端再做一次（本輪的例子：PDF 的
    `%PDF` 檢查、大小上限、「未勾確認方框」）——只擋前端等於沒有擋，
    因為 `google.script.run` 的參數完全由瀏覽器那一邊決定。
34. **用雲端 API 之前沒有問「它的預設搜尋範圍是甚麼」。** 很多 API 的
    預設值是「只看最常見那一種容器」（Drive 進階服務預設只看「我的雲端
    硬碟」，本專案偏偏全部在 Shared Drive）。這一類設定的共同特徵是：
    **不帶它不會報錯，只會回一個看起來合理、其實是錯的答案**——
    「File not found」（檔案明明在）、「沒有同名檔案」（其實有）。
    訊息會把查的人引去一個不存在的原因，見事故二十四。
35. **「可以不寫、不寫也不報錯」的錯誤處理，靠自律記得寫。**
    `google.script.run` 的 `withFailureHandler` 就是這一種：不寫也不會
    有任何警告，代價是後端的錯誤全部人間蒸發。這一類東西一定要有一個
    統一的地方寫好，再加一個靜態檢查逼所有呼叫經過它，見事故二十五。
36. **以為「沒有回應」就等於「失敗」。** 兩者是不同的狀態：失敗代表
    沒有做，可以叫人改正再試；**沒有回應代表不知道有沒有做**，叫人
    重試是危險的建議（可能會做第二次）。逾時訊息一定要講明這一點，
    並指路去可以查證的地方。順帶一提：凡是外部呼叫都要有一個有限的
    逾時，否則「永遠轉圈」會被當成當機。
37. **訊息顯示在被 modal 蓋住的那一層。** 寫了等於沒寫。使用者當下
    看得到哪一層，訊息就要出現在哪一層；有需要就兩邊都寫一份。
38. **只靠前端防重複撳。** 前端停用按鈕擋得住「同一顆按鈕連撳兩下」，
    擋不住重新整理、兩個分頁、或者請求已經送出之後才停用。後端要有
    自己的兩道：`LockService` 擋「同時」，一個短時間窗的指紋擋「一個
    做完、緊接住又來一個」——鎖擋不住後者，因為第一次早就放鎖了。
39. **用「加多幾條測試」去回應「測試全綠但一實測就中」。** 再加一百條
    同一種測試，只會令假綠燈更多——它們的**證據來源**完全一樣。寫測試
    之前先問：「這個 fixture 是我想像出來的，還是系統真的產生出來的？」
    是前者的話，它抓不到「我想像錯了」那一類 bug，見事故二十六。
40. **一個斷言只有「應該綠」的案例，沒有「應該紅」的案例。** 那樣只
    證明了它不會誤報，沒有證明它捉得到——一支永遠回 `true` 的函式一樣
    全部通過。這一輪的 I02 就是這樣被抓到的（`if (seen[key])` 在索引
    是 `0` 時是 falsy，「第一行被重複」永遠驗不出來）。
41. **把「驗證不到」當成「驗證過、沒問題」。** 兩者必須用不同的值表示
    （`null` vs `false`、`-1` vs `0`），而且要一路帶到最終報告——服務
    未啟用、檔案讀不到、前置條件未滿足，全部都是「未驗過」，不是「沒
    問題」。自測機的「略過」同理：報告要明寫「『略過』不等於『通過』」。
42. **隨機測試沒有記下「走到這裏的完整步驟」與亂數種子。** 一條隨機
    路徑紅了但重現不到，那個發現等於零。`Math.random()` 設不到種子，
    所以要自己實作一個可以設種子的產生器，見 `monkeyRandom_()`。
43. **把一條「有先決條件、或者只在某一刻成立」的檢查當成不變量。**
    不變量的定義是「**無論系統在哪一個狀態都成立**」。做不到這一點的
    是後置條件或情境斷言，要跟着它適用的情境走。放錯位置的代價不是
    「多一個紅燈」，而是**一大堆不相干的情境一齊變紅**，看報告的人會
    去修根本沒有壞的東西，見事故二十七。
44. **靠「沒有寫就當作沒有」來表示一個屬性。** 「漏寫」與「確認過是
    false」在程式碼裡面看起來一模一樣。副作用、唯讀、純文字這類會改變
    處理方式的屬性，一律要求**明明白白寫出來**，再加一條測試檢查每一
    項都寫齊了。
45. **把帶格式的字串（千分位、前導零、日期形狀、時間形狀）直接
    `setValue()` 進試算表。** Google Sheets 會自作主張轉型：`'42,150'`
    變 `42150`、`'007'` 變 `7`、`'10/5'` 變一個真正的日期。一定要
    **先 `setNumberFormat('@')` 再寫值**——次序反轉救不回，那時格式
    資訊已經丟失。而且這種 bug 一半是靜的（週報印錯數字，沒有人收到
    警告），一半是吵的（匯入永遠不冪等），見事故二十八。
46. **在一個「什麼都不做」的假替身上驗證修正。** 假的
    `setNumberFormat()` 寫成 `return this;`，那麼「先設格式再寫值」這
    個修正**修不修都是綠的**。修一個「假替身測不出來」的 bug，第一步
    是先令假替身測得出來，並且加一條測試**證明它測得出來**（見
    `tests/textformat.test.js` 的第 0 組）。
47. **一條規則只在其中一個入口實作。** 規則不是「有沒有寫過」，是
    「**有幾多個入口，是不是每一個都成立**」。寫規則之前先列出全部寫入
    入口（填寫介面、季度填寫表、批次工具、匯入、還原……），再逐個對。
    漏一個的代價是靜靜寫錯資料，見事故二十九。
48. **只認一種資料形狀的檢查。** 呼叫方送了另一種形狀（`payload.lists.x`
    而不是 `payload.x`），檢查不會報錯，只會**靜靜地什麼都不做**，然後
    報告「驗過了」。自測／測試送出去的東西，形狀必須與真實呼叫方一模
    一樣；防線本身則要對得起兩種形狀。
49. **測試在守著一個已經不再正確的承諾。** 改需求的時候要主動問「有沒有
    測試在守舊行為」。改測試時把「為什麼預期變了」寫進註解，否則下一個
    人會以為是改壞了而改回去。
50. **「整次拒絕」寫成「只擋不合格那幾項」。** 後者造成「一半成功」——
    使用者以為全部存好了。一個請求裡面混了不可以寫的東西，整個請求都要
    拒絕，並且講明「一格都沒有寫入」。
51. **算式依賴一個沒有寫出來的前提。** `目標日 = 今日 + 6` 只在「今日是
    星期一」時才對，但那個前提沒有寫在任何地方，而且有三個呼叫方不滿足
    它。寫算式時問一句「這條式在什麼情況下會錯」；答案如果是「今日不是
    星期一」，就不要用天數，直接數星期幾，見事故三十。
52. **名字講的是意圖，算式做的是實作，兩者對不上。** 讀的人會信名字。
    `targetIso = today + 6` 要求讀者自己補上「因為今日是星期一」——補不
    到就以為它是對的。
53. **「線上一直沒有出事」當成「算法正確」。** 可能只代表正式流程剛好
    滿足了那個隱藏前提。換一個入口、換一日跑，就會現形。
54. **留一個沒有人讀的設定鍵在 Config 表上。** 有人改了它，以為改到系統
    行為，其實什麼都沒有發生——比刪掉危險。廢棄的鍵要移出 `CONFIG_KEYS`／
    `DEFAULTS` 並加入 `cleanupDeprecatedConfigKeys_()`。
55. **不變量假設了只有正式環境存在。** 一條不變量若引用任何「正式環境
    專用」的設定（master 檔案、正式季度、正式收件人），在沙盒執行時就會
    **必然失敗**，並把本來通過的情境一併染紅。每條不變量都要明確聲明它
    對哪一個環境成立，或者聲明「不適用」，見事故三十一。
56. **同一種資源有正式與沙盒兩份，但為它而設的快取／指紋／時間戳只有
    一份。** 沙盒那一次會靜靜蓋走正式那一份，而且復原不到。分兩份資源，
    就要分兩份記錄。
57. **記錄推不出它當時作用在哪一個對象上。** 發佈記錄要記低「覆寫了哪一
    個檔案」，不可以靠讀 Config 反推——Config 是「現在指著哪一個」，記錄是
    「當時寫了哪一個」，兩者會不同。
58. **把兩種不同性質的紅混在一起顯示。** 「情境本身失敗」與「情境通過但
    不變量不成立」要分開講：前者是真的要修的東西，後者通常是一條檢查
    拖著一堆不相干的情境。混在一起，看的人會去查五個沒有壞的東西。
59. **測試依賴「上一個步驟剛剛做過某件事」而那件事有時限。** 每個情境
    耗時 14 至 23 秒、防重複視窗 30 秒——這種測試會間歇性紅，而紅的原因
    不是功能壞了。要令測試**自給自足**：自己造出前提，兩步之間不做任何
    其他事，而且用一個不會被上一步影響的鍵（例如另一個主日）。
60. **見到紅燈就去改被驗的功能。** 先問「是功能壞了，還是測試量錯了」。
    改功能令測試變綠，是把溫度計調低——尤其當那個功能本來就有測試證明
    它是對的（本輪：防重複有 tests/publishfix.test.js 第 9 條守著）。
61. **斷言指定了「用哪一道守門」，而不是「結果對不對」。** 系統換一道
    守門擋住，行為正確，測試卻報失敗。斷言要針對可觀察的結果（有沒有被
    擋、版本有沒有變）；至於是哪一道守門，記入證據，不寫進斷言。要驗
    某一道守門本身的話，另開一條情境並在註解寫明分工，見事故三十二。
62. **只驗「擋得到」，不驗「不該擋的時候不擋」。** 那樣只證明了它會擋，
    沒有證明它擋得準。一道守門至少要兩條測試：該擋的擋、不該擋的放行。
63. **造「兩份不同的測試資料」之前沒有確認它們真的不同。** 經過任何
    正規化（去掉非 ASCII、trim、大小寫）之後才比較，是最容易出錯的一步
    ——第二輪那兩份「不同內容」的 PDF，其實位元組完全相同。
64. **一句「對不上」當成證據。** 那是結論。報告要講得出「兩邊分別是
    什麼、分別取自哪裏、差在哪裏」，否則看的人只能靠猜，而且很可能去改
    一個沒有壞的東西。修檢查之前，先寫一個**能逐字重現那個症狀**的最小
    例子；重現不到就代表還未明白，見事故三十三。
65. **「這個假設在當時是成立的」憑印象寫，沒有回去確認。** 第二輪寫
    「自測機那時還未存在」，而事實是它已經存在了一輪——於是一個舊記錄
    被錯誤地當成正式那一邊的。要寫出**當時**是什麼時候，並回去對。
66. **一份講不出自己屬於哪一個對象的記錄，被拿來當某一個對象的記錄。**
    寧可回「不知道」（驗證不到），也不要猜一個——猜錯會報出一個假的
    「不一致」，比不報更難查。
67. **提供「把記錄對齊現況」這種動作而不講明它是承認現況。** 它不會修好
    任何東西，只會令紅燈消失。對話框一定要寫明，並叫人先看證據。
68. **「續跑」與「重播」混為一談。** 續跑是接住進度（步數接上去、亂數接住
    抽），重播是由乾淨狀態走同一條路。講「繼續」之前先問清楚接住的是
    哪一樣。做不到重播，不代表做不到續跑，見事故三十四。
69. **可以分批做的流程只存了「由哪裏開始」，沒有存「做到哪裏」。** 存起點
    只夠重來一次。用一個拿不到內部狀態的亂數產生器，等於當下就放棄了
    續跑這個選項。
70. **進度只顯示本批，不顯示累計。** 續跑三次每次都寫「走了 9 步」，一個
    從來沒有跑完過的流程看起來每次都很成功。
71. **寫「兩種做法結果相同」的等價測試而沒有寫反向測試。** 如果兩邊其實
    走同一條路（例如分批那一邊其實每次都由頭開始），等價測試會恆真。
    一定要另外寫一條「做法不同時它真的會紅」。
72. **用 `隨機值 % n` 取範圍。** 它取的是低位元，而很多產生器（尤其模 2 的
    冪的線性同餘）低位元品質極差——實測 `nextInt(8)` 是一個週期 8 的固定
    循環。要取範圍，用 `floor(value / 2^bits * n)`，見事故三十五。
73. **驗亂數品質時驗「次數分佈」而不是「序列」。** 一個固定的排列循環，
    次數分佈是完美平均的（100000 次、八個值各 12500）。要驗的是週期、
    以及相近的種子會不會走同一條路。
74. **「某個選項從來沒有被抽中過」當成巧合。** 算一算機率：25 次抽樣、
    8 個選項，三個同時零次的機率低於千分之一。低於千分之一就當成訊號去查。
75. **把不合法的選項靜靜由候選清單剔走。** 零次被揀中的東西，究竟是
    「有資格但抽不中」還是「根本沒有資格」，是兩件事——報告要分開講，
    而且不合格的要寫得出原因。
76. **覆蓋統計沒有標出「零次」的項目。** 一個從來沒有跑過的動作，看起來
    與「跑過而且沒事」一模一樣。
77. **用 Script Property／快取／全域變數做真相來源。** 它們會被清、會遺失，
    而且與它們描述的那一行**沒有綁定關係**。判斷準則：「它不見了，我還
    答得出這個問題嗎？」答不出就不是真相來源。要記「這一行發生了什麼」，
    就記在**那一行上**，見事故三十六。
78. **退而求其次的來源沒有講明它是退而求其次。** 用存檔副本的指紋去代替
    「發佈當時的指紋」是合理的推斷，但報告一定要寫明來源，否則下一個人
    會以為那是第一手記錄。
79. **設定檔寫的版本，與程式碼用的欄位名分家。** 改 API 版本時要 grep
    全部欄位名，不是只改設定檔那一行。註解講的版本與設定檔不符時，
    **信設定檔**並即刻修好註解——一句錯註解可以令一個 bug 多活幾輪。
80. **假替身比真實 API 寬鬆。** 一個「什麼都收」的假替身，會令一整類參數
    錯誤在測試裡完全隱形。做得到的話，讓它在收到錯誤形狀時**拋錯**——
    src/ 與假替身用同一個錯的假設，就是事故二十二的形狀，見事故三十七。
81. **「驗證不到」長期出現而沒有人追。** `try/catch` 回 `null` 是對的
    （三個狀態），但同一項長期報「讀不到」就是一個訊號，要去追背後的
    原因，不可以當成正常。
82. **可以分批做的流程，跨批狀態只存了一半。** 存了一半比完全沒有存更難
    查——表面上它是work的，只有其中一項不對。改完「續跑」之後要逐項問：
    「這一輪之內每一個會累積的東西，是不是都接得上？」見事故三十八。
83. **截斷長字串時截錯了一頭。** 先問「哪一頭比較重要」。走過的路、堆疊、
    歷程，**開頭**通常比結尾重要，所以截尾；而且一定要明寫截斷了幾多。
84. **用時間相近去圈「同一批」「同一次」。** 時間視窗一定會有兩種錯：
    太窄拆散一批，太闊併埋兩批——而且兩種錯都只在特定節奏下出現。
    要靠一個**明確的編號**，見事故三十九。
85. **間歇性的紅燈（有時紅有時綠）當成被驗那件事有問題。** 十次有九次是
    **判斷條件本身不確定**。先問「這個判斷條件依賴什麼？那樣東西穩定嗎？」
86. **紀錄一個失敗時只記編號，不記「預期／實際／證據」。** 等於叫下一個人
    自己重現——而隨機路徑多數重現不到。
87. **把「還未到時候」當成「出錯」。** 上游資料未齊（職事表未建立、內容表
    未填）就整條流程停下來，代價是沒有人做錯任何事，但什麼都做不到。
    正確做法：做得到的照做，欠的部分寫成**看得見的狀態**，講明欠什麼、
    怎樣補，並且提供一個**可以安全重試**的補救動作。見事故四十。
88. **補救動作不可以重試。** 「補抓一次就不可以再按」等於逼使用者等到
    上游完全齊備才敢開始。只填空白格、永不覆寫人手輸入，才有「隨時可以
    再按一次」這回事。
89. **把「未到時候」寫入 `ErrorLog`。** `ErrorLog` 每一行都應該是真的有人
    做錯了什麼；混入正常情況之後，那張表就沒有人看了。
