import ctypes, time, sys
from ctypes import wintypes
from PIL import ImageGrab
try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception: ctypes.windll.user32.SetProcessDPIAware()
u32=ctypes.windll.user32
KEYUP=0x0002; VK_ESC=0x1B; VK_MENU=0x12; VK_T=0x54

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
def tap(vk):
    u32.keybd_event(vk,0,0,0); u32.keybd_event(vk,0,KEYUP,0); time.sleep(0.06)
def alt_t():
    u32.keybd_event(VK_MENU,0,0,0); time.sleep(0.06)
    tap(VK_T)
    u32.keybd_event(VK_MENU,0,KEYUP,0)

e=find(lambda t:'Edge' in t and 'DevTools' not in t)[0]
u32.SetForegroundWindow(e[0]); time.sleep(0.8)
# 先关掉可能存在的弹窗
tap(VK_ESC); time.sleep(0.6)
ImageGrab.grab().save('test/live-on.png')
alt_t()
print('已按 Alt+T（第二次）')
time.sleep(3.5)
ImageGrab.grab().save('test/live-off.png')
print('截图完成')
