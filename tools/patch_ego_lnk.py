"""给现有的 ego 快捷方式补上扩展加载参数（先备份原值）"""
import json
import os
import win32com.client

BS = chr(92)
EXT = f"D:{BS}浏览器翻译插件"
TAG = "--load-extension="
BACKUP = f"D:{BS}浏览器翻译插件{BS}tools{BS}lnk-backup.json"

LINKS = [
    f"C:{BS}ProgramData{BS}Microsoft{BS}Windows{BS}Start Menu{BS}Programs{BS}ego (lite).lnk",
    f"C:{BS}Users{BS}Public{BS}Desktop{BS}ego (lite).lnk",
]

shell = win32com.client.Dispatch("WScript.Shell")
backup = {}

for p in LINKS:
    if not os.path.exists(p):
        print("跳过(不存在):", p)
        continue
    sc = shell.CreateShortCut(p)
    target = sc.TargetPath
    args = sc.Arguments
    backup[p] = {"TargetPath": target, "Arguments": args}
    print("=" * 60)
    print("文件:", p)
    print("  目标:", target)
    print("  原参数:", repr(args))
    if os.path.basename(target).lower() != "ego.exe":
        print("  ! 目标不是 ego.exe，跳过修改")
        continue
    if TAG in args:
        print("  已包含扩展参数，无需修改")
        continue
    new_args = (args + " " if args else "") + f'{TAG}"{EXT}"'
    sc.Arguments = new_args
    sc.Save()
    chk = shell.CreateShortCut(p)
    print("  新参数:", chk.Arguments)
    print("  写入校验:", TAG in chk.Arguments)

with open(BACKUP, "w", encoding="utf-8") as f:
    json.dump(backup, f, ensure_ascii=False, indent=2)
print("\n原值已备份到:", BACKUP)
