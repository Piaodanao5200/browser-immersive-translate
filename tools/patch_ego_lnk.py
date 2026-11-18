"""给 ego 快捷方式设置扩展加载参数（指向项目当前所在目录）

- 系统级快捷方式（ProgramData / 公共桌面）需要管理员权限；写不进去时给出提示，不中断。
- 无论如何都会在「当前用户」下建/更新一个「ego (lite) 带翻译」快捷方式（桌面 + 开始菜单），
  这个一定写得进去，双击它启动就能带上扩展。
- 可重复运行：已有的 --load-extension 会被替换成当前路径，不会叠加。
原厂参数备份在 tools/lnk-backup.json（只在文件不存在时写入，避免覆盖原始备份）。
"""
import json
import os
import re
import sys

import win32com.client

BS = chr(92)
# 项目根目录 = 本脚本所在 tools 的上一级
EXT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TAG = "--load-extension="
BACKUP = os.path.join(EXT, "tools", "lnk-backup.json")
EGO = f"C:{BS}Program Files{BS}Citro Labs{BS}ego lite{BS}Application{BS}ego.exe"

SYSTEM_LINKS = [
    f"C:{BS}ProgramData{BS}Microsoft{BS}Windows{BS}Start Menu{BS}Programs{BS}ego (lite).lnk",
    f"C:{BS}Users{BS}Public{BS}Desktop{BS}ego (lite).lnk",
]
USER_LINKS = [
    os.path.join(os.environ["USERPROFILE"], "Desktop", "ego (lite) 带翻译.lnk"),
    os.path.join(os.environ["APPDATA"], "Microsoft", "Windows", "Start Menu", "Programs", "ego (lite) 带翻译.lnk"),
]

shell = win32com.client.Dispatch("WScript.Shell")
cur = {}
failed = []
# 留一个调试端口，方便 tools/diag-live.mjs 连上「已登录」的浏览器排查问题
DEBUG_PORT = os.environ.get("EGO_DEBUG_PORT", "9222")
DEBUG_ARG = f"--remote-debugging-port={DEBUG_PORT}"


def set_args(path, args, note=""):
    """去掉旧的 load-extension，再补上当前路径"""
    cleaned = re.sub(r'\s*--load-extension=("[^"]*"|\S+)', "", args).strip()
    return (cleaned + " " if cleaned else "") + f'{TAG}"{EXT}"'


for p in SYSTEM_LINKS:
    if not os.path.exists(p):
        print("跳过(不存在):", p)
        continue
    sc = shell.CreateShortCut(p)
    target, args = sc.TargetPath, sc.Arguments
    cur[p] = {"TargetPath": target, "Arguments": args}
    print("=" * 64)
    print("文件:", p)
    print("  原参数:", repr(args))
    if os.path.basename(target).lower() != "ego.exe":
        print("  ! 目标不是 ego.exe，跳过")
        continue
    if EXT in args and args.count(TAG) == 1:
        print("  已指向当前目录，无需修改")
        continue
    try:
        sc.Arguments = set_args(p, args)
        sc.Save()
        print("  新参数:", shell.CreateShortCut(p).Arguments)
    except Exception as e:
        print("  ! 没有权限写入（需要管理员）:", getattr(e, "hresult", e))
        failed.append(p)

print("=" * 64)
for p in USER_LINKS:
    os.makedirs(os.path.dirname(p), exist_ok=True)
    sc = shell.CreateShortCut(p)
    sc.TargetPath = EGO
    sc.Arguments = f'{TAG}"{EXT}" {DEBUG_ARG}'
    sc.WorkingDirectory = os.path.dirname(EGO)
    sc.IconLocation = EGO + ",0"
    sc.Description = "启动 ego 并加载字幕译扩展"
    sc.Save()
    chk = shell.CreateShortCut(p)
    ok = EXT in chk.Arguments
    print(("已更新: " if ok else "失败  : ") + p)

if not os.path.exists(BACKUP):
    with open(BACKUP, "w", encoding="utf-8") as f:
        json.dump(cur, f, ensure_ascii=False, indent=2)
    print("\n原始参数已备份到:", BACKUP)

print("\n扩展目录:", EXT)
if failed:
    print("\n以下系统快捷方式需要管理员权限才能改：")
    for p in failed:
        print("  ", p)
    print("  处理方式：右键 tools/fix_ego_lnk_admin.bat → 以管理员身份运行")
    sys.exit(2)
