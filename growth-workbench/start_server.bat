@echo off
rem 科研工作台统一入口：起后端 + 公网隧道（逻辑在 bin\launch.ps1，桌面双击/开机自启走同一条链路）
rem 只想后台起服务、不开浏览器时也用它。
cd /d "%~dp0"
start "" wscript.exe "%~dp0bin\launch.vbs" boot
