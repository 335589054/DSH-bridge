@echo off
chcp 65001 >nul
setlocal

echo ================================================
echo  WorkBuddy Bridge 本地 CA - 从当前用户移除
echo ================================================
echo.

certutil -user -delstore Root "WorkBuddy Bridge Local CA"
if errorlevel 1 (
  echo.
  echo [!] 没找到这张证书，可能本来就没装过。
  echo.
  pause
  exit /b 1
)

echo.
echo [√] 已移除。DeepSeek Harness 里的 WorkBuddy 模型仍可用，
echo     但「重新抓包」之前需要再装一次证书。
echo.
pause
exit /b 0
