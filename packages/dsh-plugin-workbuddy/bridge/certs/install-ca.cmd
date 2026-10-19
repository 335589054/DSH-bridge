@echo off
chcp 65001 >nul
setlocal
set "CER=%~dp0mitmproxy-ca-cert.cer"

echo ================================================
echo  WorkBuddy Bridge 本地 CA - 安装到当前用户
echo ================================================
echo.

if not exist "%CER%" (
  echo [x] 找不到证书文件：
  echo     %CER%
  echo     请确认解压时没有删掉 bridge\certs 目录。
  echo.
  pause
  exit /b 1
)

echo 正在写入「当前用户 / 受信任的根证书颁发机构」...
echo.
certutil -user -addstore -f Root "%CER%"
if errorlevel 1 goto failed

echo.
certutil -user -store Root "WorkBuddy Bridge Local CA" | find /i "WorkBuddy Bridge Local CA" >nul
if errorlevel 1 goto failed

echo [√] 安装完成。
echo.
echo     回到 DeepSeek Harness 的 Settings - WorkBuddy，点「重新检测」，
echo     证书那一行应显示「已信任」。
echo.
pause
exit /b 0

:failed
echo.
echo [!] 自动安装没成功（可能是安全策略拦截了证书库写入）。
echo.
echo     手动安装（任选一种）：
echo       1) 双击这个文件，选「安装证书」-^>「当前用户」-^>「受信任的根证书颁发机构」
echo          %CER%
echo       2) 右键本脚本「以管理员身份运行」
echo       3) 在「管理用户证书」里导入上面这个 .cer 到「受信任的根证书颁发机构」
echo.
pause
exit /b 1
