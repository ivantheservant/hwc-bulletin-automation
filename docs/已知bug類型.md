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
6. **（本次新增）跨檔案的頂層初始化式，依賴 `.gs` 檔案的載入次序。**
   Apps Script 按檔名字母序執行每個檔案的頂層陳述式；任何頂層
   `var`／`const`／`let` 的賦值運算式，如果引用了另一個檔案宣告的
   識別碼，就是在賭「那個檔案剛好排在我前面」——賭錯的後果是整個
   專案載入失敗，而且是靜靜失敗、沒有任何使用者看得到的錯誤提示。
   凡是需要引用其他檔案常數／函式的初始化資料，一律包成函式延遲
   求值，讓它在被呼叫的那一刻才求值，而不是在檔案載入的那一刻。
