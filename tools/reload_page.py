import ctypes, time, sys
from ctypes import wintypes
from PIL import ImageGrab
try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception: ctypes.windll.user32.SetProcessDPIAware()
u32=ctypes.windll.user32
KEYUP=0x0002; VK_F5=0x74
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
e=[w for w in find(lambda t:'Edge' in t and 'DevTools' not in t)]
if not e: print('无 Edge'); sys.exit(1)
h=e[0][0]; u32.ShowWindow(h,3); u32.SetForegroundWindow(h); time.sleep(0.8)
u32.keybd_event(VK_F5,0,0,0); u32.keybd_event(VK_F5,0,KEYUP,0)
time.sleep(3.2)
ImageGrab.grab().save('test/shot-refreshed.png')
print('已刷新并截图')
