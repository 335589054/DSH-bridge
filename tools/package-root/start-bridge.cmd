@echo off
chcp 65001 >nul
rem zip 根的双击入口：转到 bridge\start.cmd（那里才是真正的启动逻辑）
call "%~dp0bridge\start.cmd" %*
