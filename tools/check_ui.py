import ctypes, time, sys
from ctypes import wintypes
from PIL import ImageGrab
try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception: ctypes.windll.user32.SetProcessDPIAware()
u32=ctypes.windll.user32
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
e=find(lambda t:'Edge' in t and 'DevTools' not in t)[0]
u32.ShowWindow(e[0],3); u32.SetForegroundWindow(e[0]); time.sleep(1.0)
ImageGrab.grab().save('test/shot-toolbar.png')
im=ImageGrab.grab()
im.crop((im.size[0]-900,0,im.size[0],180)).save('test/crop-toolbar.png')
print('工具栏截图完成')
