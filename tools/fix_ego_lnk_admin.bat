@echo off
chcp 65001 >nul
rem 以管理员身份运行，用来修改系统级 ego 快捷方式（开始菜单/公共桌面）
python "%~dp0patch_ego_lnk.py"
echo.
pause
