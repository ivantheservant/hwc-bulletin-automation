@echo off
REM ============================================================
REM deploy.bat ---- 一鍵部署（週報系統）
REM
REM 順序：clasp push -> git add -> git commit -> git push -> clasp deploy
REM 任何一步失敗就立即停止，顯示是哪一步、離開碼、以及常見原因。
REM
REM 用法：
REM     deploy.bat "這次改動的說明"
REM     deploy.bat                      （不給訊息就用預設訊息）
REM
REM ⚠️ 部署 ID 不寫在本檔案內（docs/已知bug類型.md：原始碼不放任何真實
REM ID）。改為讀取同一個資料夾的 deployment-id.txt，該檔已列入 .gitignore，
REM 永遠不會被 commit 上 GitHub。
REM
REM ⚠️ 本檔案刻意**不用** EnableDelayedExpansion，也刻意不在 if 區塊
REM 內引用 %errorlevel%——批次檔會在解析整個區塊時就把 %errorlevel% 展開，
REM 印出來的會是上一個指令的舊值。所以每一步都是「跑完立刻把離開碼
REM 存進 RC，再用 goto 跳去對應的失敗標籤」。
REM ============================================================

setlocal EnableExtensions

set "REPO_DIR=%~dp0"
set "DEPLOY_ID_FILE=%REPO_DIR%deployment-id.txt"

REM ---- commit 訊息：第一個參數；沒有給就用預設 ----
set "COMMIT_MSG=%~1"
if "%COMMIT_MSG%"=="" set "COMMIT_MSG=更新週報系統"

echo ============================================================
echo  週報系統一鍵部署
echo  commit 訊息：%COMMIT_MSG%
echo ============================================================
echo.

REM ---- 第 0 步：讀部署 ID ----
if not exist "%DEPLOY_ID_FILE%" goto :no_deployment_id

set "DEPLOYMENT_ID="
for /f "usebackq delims=" %%i in ("%DEPLOY_ID_FILE%") do if not defined DEPLOYMENT_ID set "DEPLOYMENT_ID=%%i"
if not defined DEPLOYMENT_ID goto :no_deployment_id

cd /d "%REPO_DIR%"
set "RC=%errorlevel%"
if not "%RC%"=="0" goto :fail_cd

REM ---- 第 1 步：clasp push ----
echo [1/5] clasp push --force
call clasp push --force
set "RC=%errorlevel%"
if not "%RC%"=="0" goto :fail_push
echo.

REM ---- 第 2 步：git add ----
echo [2/5] git add -A
git add -A
set "RC=%errorlevel%"
if not "%RC%"=="0" goto :fail_add
echo.

REM ---- 第 3 步：git commit ----
REM 沒有任何改動不算失敗（例如只想重新部署一次），所以先看有沒有東西
REM 排隊等 commit：git diff --cached --quiet 有差異時回 1、沒有差異回 0。
git diff --cached --quiet
set "RC=%errorlevel%"
if "%RC%"=="0" goto :skip_commit

echo [3/5] git commit
git commit -m "%COMMIT_MSG%"
set "RC=%errorlevel%"
if not "%RC%"=="0" goto :fail_commit
goto :after_commit

:skip_commit
echo [3/5] git commit ---- 沒有任何改動，略過

:after_commit
echo.

REM ---- 第 4 步：git push ----
echo [4/5] git push
git push
set "RC=%errorlevel%"
if not "%RC%"=="0" goto :fail_push_git
echo.

REM ---- 第 5 步：clasp deploy ----
echo [5/5] clasp deploy
call clasp deploy -i %DEPLOYMENT_ID% -d "%COMMIT_MSG%"
set "RC=%errorlevel%"
if not "%RC%"=="0" goto :fail_deploy
echo.

echo ============================================================
echo  全部完成。
echo.
echo  仍需人手：試算表 ^> 週報系統 ^> 初始化工作表
echo.
echo  （新增了 Config 鍵或 BulletinWeeks 欄位之後一定要撳一次。
echo    這一步是冪等的，撳多幾次不會有副作用。）
echo ============================================================
exit /b 0

REM ============================================================
REM 失敗標籤
REM ============================================================

:fail_cd
echo [失敗] 第 0 步：進不到 repo 資料夾（離開碼 %RC%）。
echo        資料夾：%REPO_DIR%
exit /b 1

:fail_push
echo.
echo [失敗] 第 1 步 clasp push 失敗（離開碼 %RC%）。
echo        常見原因：未登入（跑一次 clasp login）、.clasp.json 的 scriptId 不對、
echo        或者某個 .gs 有語法錯誤。上面 clasp 的訊息有講明是哪一個。
echo        後面幾步全部沒有執行，本機與 GitHub 都沒有任何改動。
exit /b 1

:fail_add
echo.
echo [失敗] 第 2 步 git add 失敗（離開碼 %RC%）。
echo        常見原因：這個資料夾不是一個 git repo，或者檔案被其他程式鎖住。
exit /b 1

:fail_commit
echo.
echo [失敗] 第 3 步 git commit 失敗（離開碼 %RC%）。
echo        常見原因：未設定 user.name／user.email，或者 pre-commit 掛鉤擋住。
echo        改動仍然留在暫存區（已經 git add 過），修好之後可以直接再跑一次。
exit /b 1

:fail_push_git
echo.
echo [失敗] 第 4 步 git push 失敗（離開碼 %RC%）。
echo        常見原因：遠端有新 commit 要先 git pull，或者沒有推送權限。
echo        commit 已經做好，修好之後可以直接再跑一次。
exit /b 1

:fail_deploy
echo.
echo [失敗] 第 5 步 clasp deploy 失敗（離開碼 %RC%）。
echo        常見原因：deployment-id.txt 內的部署 ID 不對，或者那個部署已經被刪除。
echo        正確的 ID 在 Apps Script ^> 部署 ^> 管理部署作業 取得。
echo        程式碼已經 push 上 Apps Script 與 GitHub，只差這一步把它發佈出去。
exit /b 1

:no_deployment_id
echo [失敗] 找不到部署 ID。
echo.
echo        請建立 deployment-id.txt，內容為 Web App 部署 ID
echo        （在 Apps Script ^> 部署 ^> 管理部署作業 取得）。
echo.
echo        檔案位置：%DEPLOY_ID_FILE%
echo        檔案內容：一行，只放那個 ID，不要加引號。
echo.
echo        這個檔案已列入 .gitignore，不會被 commit 上 GitHub。
exit /b 1
