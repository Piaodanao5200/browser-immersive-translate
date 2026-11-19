@echo off
rem 带调试端口启动 Edge（用默认配置，登录态不丢），供 tools/diag-live.mjs 连上去诊断。
rem 先完全退出 Edge（含托盘里的后台进程），再双击本文件。
set EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
if not exist "%EDGE%" set EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe
start "" "%EDGE%" --remote-debugging-port=9222 --restore-last-session
