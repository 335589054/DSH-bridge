@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================================
echo   WorkBuddy x DeepSeek Harness  一键安装
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [x] 没找到 node 命令。请先安装 Node.js 22.19 或更新版本：
  echo     https://nodejs.org
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -p "process.versions.node"') do set NODEVER=%%v
echo Node %NODEVER%
echo.

node "dsh-plugin-workbuddy\install.mjs" --quick %*
set CODE=%errorlevel%

echo.
if not "%CODE%"=="0" (
  echo [x] 安装器退出码 %CODE%。把上面的输出发出来就能定位问题。
  echo.
)
pause
exit /b %CODE%
