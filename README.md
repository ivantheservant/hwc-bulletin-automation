# 粵語堂週報自動生成系統 Bulletin Automation

一個綁定在 Google 試算表上的 Google Apps Script 專案，為 ECF Holy Word Church of
Auckland 粵語堂自動產生每個主日的週報（崇拜程序、封面、奉獻與人數、家事報告、
代禱事項、團契聚會），並在每星期一自動把下一個主日的週報寄給堂委、執事與幹事。

## ⚠️ 本 Repo 只含程式碼，不含任何個人資料

所有真實資料——會友姓名、電郵地址、崇拜人數、試算表與資料夾 ID——一律只存在於
腳本綁定的私有 Google 試算表，**從未、也不會**出現在這個 repo 裡。

原始碼依照「一切可配置，不可寫死」的原則撰寫：所有 ID、電郵、時間、範本、
特別主日程序差異，一律由 `Config` 工作表讀取。

## 與職事表系統的關係

本系統從粵語堂職事表系統（<https://github.com/ivantheservant/hwc-roster-automation>）
取得事奉名單。

**硬規則：對職事表試算表一律唯讀，一個格都不會寫。**

- 只使用 `SpreadsheetApp.openById()`，整個 codebase 不得出現任何對職事表試算表的
  寫入呼叫（有靜態掃描與測試鎖住）
- 只讀 `Config` 明列的工作表與欄位，未列出的一律不碰
- 職事表試算表 ID 未設定時回一個獨立旗標 `notConfigured`，畫面明講「還沒有設定
  職事表位置」，**不會靜靜當成「沒有資料」**
- 讀不到或無權限時明確拋錯並講原因，不會退回空陣列
- 2026-12-04（2027T1 職事表上線）之前，本系統不得要求職事表改動任何一行程式碼；
  有需要一律記入 `docs/待補資料.md`

## 技術棧

- **執行環境**：Google Apps Script（V8 runtime），綁定於週報試算表
- **語言**：JavaScript（`.gs`），介面用 `HtmlService`
- **部署工具**：`clasp`
- **輸出**：由 Google Docs 範本複製 → 佔位符替換 → 匯出 PDF
- **資料層**：全部資料存於週報試算表的多個工作表，沒有外部資料庫

## 沿用職事表的既有做法

- `Config` 工作表存全部參數；`Diagnostics` 工作表存唯讀報告
  （**上限約 380 行**——Google Drive connector 大約 400 行就會截斷）
- `DRY_RUN` 開關保護所有寄送動作
- `AuditLog` 逐格記錄
- 不刪行，只用 `Active=FALSE` 或 `EffectiveTo`
- 工作表第 1 行中文標題、第 2 行機器鍵、資料由第 3 行開始
- commit 前要跑的檢查：
  - `node tools/scan-staged-secrets.js`　（掃描即將 commit 的內容有沒有真實個資）
  - `node tools/lint-load-order.js`　（`.gs` 檔案的頂層初始化式不可以依賴載入次序）
  - `node tools/lint-readonly-roster.js`　（對職事表試算表一律唯讀，一個格都不可以寫）
  - `node tools/lint-drive-shared.js`　（每一個 Drive 進階服務呼叫都要帶 `supportsAllDrives`）
  - `node tools/lint-roster-quarter.js`　（「決定哪一季」的退回鏈，不可以用來決定「去職事表拿哪一季的資料」）
  - `node tools/lint-service-dates.js`　（「這一季有哪幾個主日」只准經 `resolveQuarterServiceDateEntries_()` 拿）

## 目錄

```
src/     Apps Script 原始碼（clasp push 的來源）
docs/    規格與操作說明
tests/   Node.js 回歸測試（不依賴 SpreadsheetApp，可直接 node 執行）
tools/   commit 前敏感資料掃描與靜態檢查
```
