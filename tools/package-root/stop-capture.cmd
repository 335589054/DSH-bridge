@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 停止抓包并还原系统代理...
echo.
node bridge\ctl.mjs capture stop
echo.
node bridge\ctl.mjs status
pause
