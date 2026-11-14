"""生成 ego 的带扩展启动脚本与快捷方式（避免手写路径转义出错）"""
import os
import subprocess

BS = chr(92)  # 反斜杠
EGO = f"C:{BS}Program Files{BS}Citro Labs{BS}ego lite{BS}Application{BS}ego.exe"
EXT = f"D:{BS}浏览器翻译插件"
TOOLS = f"D:{BS}浏览器翻译插件{BS}tools"


def make_cmd():
    lines = [
        "@echo off",
        f'start "" "{EGO}" --load-extension="{EXT}" --restore-last-session',
        "exit",
        "",
    ]
    path = os.path.join(TOOLS, "启动ego带翻译.cmd")
    with open(path, "w", encoding="gbk", newline="\r\n") as f:
        f.write("\n".join(lines))
    return path


def make_shortcut():
    """生成 .lnk 快捷方式（优先用 pylnk3，没有则退回 COM）"""
    lnk = os.path.join(TOOLS, "ego 带翻译.lnk")
    try:
        from pylnk3 import Lnk
    except ImportError:
        subprocess.run(["python", "-m", "pip", "install", "pylnk3", "-q"], check=False)
        try:
            from pylnk3 import Lnk
        except ImportError:
            return None
    item = Lnk()
    item.link_info.local_base_path = EGO
    item.path = EGO
    item.arguments = f'--load-extension="{EXT}" --restore-last-session'
    item.work_dir = os.path.dirname(EGO)
    item.name = "ego 带翻译"
    item.save(lnk)
    return lnk


if __name__ == "__main__":
    c = make_cmd()
    print("cmd:", c)
    print(open(c, "rb").read().decode("gbk"))
    l = make_shortcut()
    print("lnk:", l)
