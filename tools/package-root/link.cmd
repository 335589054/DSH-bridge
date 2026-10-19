@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在读取桥接链接（已复制到剪贴板）...
echo.
node bridge\link.mjs --copy
echo.
pause
