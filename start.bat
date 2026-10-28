@echo off
chcp 65001 >nul
title TransForge 1:1 原位屏幕实时翻译服务 (iOS & PC)
echo ======================================================================
echo   TransForge — 1:1 原位屏幕实时翻译工作台 (iOS 快捷指令 + PC 双端通用)
echo   正在启动本地服务: http://localhost:8765
echo ======================================================================
cd /d "%~dp0server"
start "" "http://localhost:8765"
python main.py
pause
