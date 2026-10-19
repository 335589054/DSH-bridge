@echo off
chcp 65001 >nul
setlocal
rem Start bridge in a separate minimized window; closing this console keeps it alive.
rem Skip if an instance is already listening (probe /health first).
rem Exception: an instance started from inside WorkBuddy (self-hosted) gets replaced,
rem because capture restarts the client and would take that bridge down with it.
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [x] 找不到 node.exe，先装 Node.js 22 或 24
  pause
  exit /b 1
)

rem Already running: check whether it was started from inside WorkBuddy.
rem node prints the pid only in that case.
set SELFPID=
for /f "usebackq tokens=*" %%p in (`node -e "fetch('http://127.0.0.1:8790/health').then(r=>r.json()).then(j=>{if(j.selfHosted)console.log(j.pid)}).catch(()=>{})" 2^>nul`) do set SELFPID=%%p
if defined SELFPID (
  echo [i] 当前 bridge 是从 WorkBuddy 里启动的（PID %SELFPID%），抓包时会把它一起带走，先换掉
  taskkill /PID %SELFPID% /F >nul 2>&1
  call :waitdie
  if errorlevel 1 (
    pause
    exit /b 1
  )
  echo [ok] 旧 bridge 已退出，起一份新的
)

node -e "fetch('http://127.0.0.1:8790/health').then(r=>r.json()).then(j=>console.log('mode='+j.mode)).catch(()=>process.exit(1))" >nul 2>nul
if not errorlevel 1 (
  echo [i] bridge 已经在 8790 上跑着，不用再起
  exit /b 0
)

echo [.] 启动 bridge（日志 %~dp0bridge.log）
start "workbuddy-bridge" /min cmd /c "node \"%~dp0server.mjs\" >> \"%~dp0bridge.log\" 2>&1"

rem Wait until it listens, then report health once.
for /l %%i in (1,1,20) do (
  node -e "fetch('http://127.0.0.1:8790/health').then(r=>r.json()).then(j=>{console.log('[ok] mode='+j.mode+' authReady='+j.authReady);process.exit(0)}).catch(()=>process.exit(1))" >nul 2>&1
  if not errorlevel 1 goto done
  ping -n 2 127.0.0.1 >nul
)
echo [!] 10 秒内没连上，看看 %~dp0bridge.log
pause
exit /b 1

:done
echo.
echo 接着重启一次 DeepSeek Harness 就能看到新界面。
exit /b 0

rem Wait for the self-hosted bridge to release the port. Returns 0 when /health stops
rem answering, 1 after ~10s (caller prints the hint and bails).
:waitdie
for /l %%i in (1,1,10) do (
  node -e "fetch('http://127.0.0.1:8790/health').then(()=>process.exit(0)).catch(()=>process.exit(1))" >nul 2>nul
  if errorlevel 1 exit /b 0
  ping -n 2 127.0.0.1 >nul
)
echo [!] 旧 bridge 10 秒还没退出，去任务管理器手动结束 PID %SELFPID% 再运行本脚本
exit /b 1
