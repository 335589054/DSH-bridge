@echo off
chcp 65001 >nul
cd /d "%~dp0"
call "bridge\certs\install-ca.cmd"
