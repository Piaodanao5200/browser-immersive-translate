"""用 pywin32 生成 ego 带扩展启动的快捷方式"""
import os
import win32com.client

BS = chr(92)
EGO = f"C:{BS}Program Files{BS}Citro Labs{BS}ego lite{BS}Application{BS}ego.exe"
EXT = f"D:{BS}浏览器翻译插件"
LNK = f"D:{BS}浏览器翻译插件{BS}tools{BS}ego 带翻译.lnk"

shell = win32com.client.Dispatch("WScript.Shell")
sc = shell.CreateShortCut(LNK)
sc.TargetPath = EGO
sc.Arguments = f'--load-extension="{EXT}" --restore-last-session'
sc.WorkingDirectory = os.path.dirname(EGO)
sc.IconLocation = f"{EGO},0"
sc.Description = "启动 ego 并加载字幕译扩展"
sc.Save()

print("已创建:", LNK, os.path.exists(LNK))
# 回读验证
chk = shell.CreateShortCut(LNK)
print("Target:", chk.TargetPath)
print("Arguments:", chk.Arguments)
