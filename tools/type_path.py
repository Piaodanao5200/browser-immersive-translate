import ctypes, time, sys
from ctypes import wintypes
from PIL import ImageGrab
try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception: ctypes.windll.user32.SetProcessDPIAware()
u32 = ctypes.windll.user32
UNICODE=0x0004; KEYUP=0x0002

def gtext(h):
    n=u32.GetWindowTextLengthW(h); b=ctypes.create_unicode_buffer(n+1)
    u32.GetWindowTextW(h,b,n+1); return b.value

def find(pred):
    out=[]
    P=ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(h,l):
        t=gtext(h)
        if t and pred(t) and u32.IsWindowVisible(h): out.append((h,t))
        return True
    u32.EnumWindows(P(cb),0); return out

def type_text(s):
    for ch in s:
        c=ord(ch)
        u32.keybd_event(0,c,UNICODE,0)
        u32.keybd_event(0,c,UNICODE|KEYUP,0)
        time.sleep(0.02)

dlg=find(lambda t:'选择扩展目录' in t)
if not dlg: print('对话框不存在'); sys.exit(1)
h,t=dlg[0]
print('对话框:',h,t)
u32.SetForegroundWindow(h); time.sleep(0.6)
# 清空再输入
VK_A, VK_CTRL, VK_END = 0x41, 0x11, 0x23
u32.keybd_event(VK_CTRL,0,0,0); u32.keybd_event(VK_A,0,0,0)
u32.keybd_event(VK_A,0,KEYUP,0); u32.keybd_event(VK_CTRL,0,KEYUP,0); time.sleep(0.2)
type_text('D://浏览器翻译插件')
time.sleep(0.5)
ImageGrab.grab().save('test/shot-typed.png')
print('已输入路径')
