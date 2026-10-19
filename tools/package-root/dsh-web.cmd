@echo off
rem Launch the DeepSeek Harness web UI (default port 3080) from the zip root.
rem Double-click it: if the web app is not running, it starts one and lets the
rem browser open the token URL; if it is already running, it just opens 127.0.0.1:3080.
setlocal
set DSH_CLI=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd
where dsh >nul 2>&1
if not errorlevel 1 set DSH_CLI=dsh

node -e "fetch('http://127.0.0.1:3080/',{redirect:'manual'}).then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>nul
if not errorlevel 1 goto running

echo.
echo   Starting DSH web UI on 127.0.0.1:3080 ...
echo   Your browser opens the printed token URL. Closing this window stops the web UI.
echo.
call "%DSH_CLI%" --profile web
echo.
echo Web UI exited. Press any key to close.
pause >nul
exit /b 0

:running
echo.
echo   DSH web UI is already running on 127.0.0.1:3080.
echo   Always open http://127.0.0.1:3080/ - NOT localhost: the login
echo   cookie is per-authority, so localhost asks you to sign in again.
echo.
start "" http://127.0.0.1:3080/
echo Press any key to close.
pause >nul
exit /b 0
