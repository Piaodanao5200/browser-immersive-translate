@echo off
rem 以「带字幕译扩展」的方式启动 ego；扩展路径取自本文件所在目录的上一级，换目录不用改
setlocal
for %%i in ("%~dp0..") do set "EXT=%%~fi"
start "" "C:\Program Files\Citro Labs\ego lite\Application\ego.exe" --load-extension="%EXT%" --restore-last-session
endlocal
exit
