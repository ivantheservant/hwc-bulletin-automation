@echo off
REM ============================================================
REM deploy_multi.bat -- push the same code to every congregation listed in deploy-targets.txt
REM (multi-congregation option A: one code base, one Apps Script project per congregation).
REM
REM Usage:  deploy_multi.bat "change description"
REM
REM deploy-targets.txt (NOT committed; see deploy-targets.example.txt) has one line per target:
REM     NAME  SCRIPT_ID  DEPLOYMENT_ID
REM Lines starting with # are ignored. NAME must have no spaces (e.g. english).
REM
REM For each target this script writes deploy-targets\NAME\.clasp.json (rootDir ../../src),
REM then runs "clasp push --force" and "clasp deploy -i DEPLOYMENT_ID" from that folder.
REM The main .clasp.json in the repo root is never touched.
REM It does NOT git commit / git push (deploy.bat does that for the main congregation).
REM Stops at the first failure and says which target failed.
REM After it finishes: open each target's spreadsheet and run the first menu item (initialize sheets).
REM ============================================================
setlocal EnableExtensions
cd /d "%~dp0"
set "MSG=%~1"
if "%MSG%"=="" set "MSG=update"
if not exist "deploy-targets.txt" goto :no_targets
set "COUNT=0"
for /f "usebackq eol=# tokens=1,2,3" %%a in ("deploy-targets.txt") do (
  call :one "%%a" "%%b" "%%c"
  if errorlevel 1 goto :failed
  set /a COUNT+=1
)
echo.
echo ============================================================
echo  Done: %COUNT% target(s) pushed and deployed.
echo  Next: in EACH target spreadsheet run the first menu item (initialize sheets),
echo        then the menu item for the config diff report.
echo ============================================================
exit /b 0

:one
set "T_NAME=%~1"
set "T_SID=%~2"
set "T_DID=%~3"
if "%T_DID%"=="" (
  echo [FAILED] target "%T_NAME%": line needs NAME SCRIPT_ID DEPLOYMENT_ID
  exit /b 1
)
echo.
echo ---- target %T_NAME% ----
if not exist "deploy-targets\%T_NAME%" mkdir "deploy-targets\%T_NAME%"
> "deploy-targets\%T_NAME%\.clasp.json" echo {"scriptId":"%T_SID%","rootDir":"../../src","scriptExtensions":[".js",".gs"],"htmlExtensions":[".html"],"jsonExtensions":[".json"],"filePushOrder":[],"skipSubdirectories":false}
pushd "deploy-targets\%T_NAME%"
call clasp push --force
set "RC=%errorlevel%"
if not "%RC%"=="0" (
  popd
  echo [FAILED] target %T_NAME%: clasp push exit code %RC%
  exit /b 1
)
call clasp deploy -i %T_DID% -d "%MSG%"
set "RC=%errorlevel%"
popd
if not "%RC%"=="0" (
  echo [FAILED] target %T_NAME%: clasp deploy exit code %RC%
  exit /b 1
)
exit /b 0

:no_targets
echo [FAILED] deploy-targets.txt not found. Copy deploy-targets.example.txt to deploy-targets.txt and fill in the IDs.
exit /b 1

:failed
echo.
echo [FAILED] Stopped. Targets before the failed one were already deployed; later ones were not.
exit /b 1
