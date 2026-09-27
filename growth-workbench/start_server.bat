@echo off
rem WB-GrowthWorkbench launcher: minimized window, logs to server.log
cd /d "D:\03-Codes\2026-09-20-01-46-40\growth-workbench\server"
set PY=C:\Users\Amber\.workbuddy\binaries\python\envs\default\Scripts\python.exe
start "WB-GrowthWorkbench" /min cmd /c ""%PY%" -m uvicorn main:app --host 127.0.0.1 --port 8000 > "%~dp0server\server.log" 2>&1"
