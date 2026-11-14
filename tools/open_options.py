import ctypes, time, sys
from ctypes import wintypes
from PIL import ImageGrab
try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception: ctypes.windll.user32.SetProcessDPIAware()
u32=ctypes.windll.user32
KEYUP=0x0002; UNICODE=0x0004
VK_CTRL,VK_L,VK_RETURN=0x11,0x4C,0x0D
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
        u32.keybd_event(0,c,UNICODE,0); u32.keybd_event(0,c,UNICODE|KEYUP,0); time.sleep(0.012)
def tap(vk):
    u32.keybd_event(vk,0,0,0); u32.keybd_event(vk,0,KEYUP,0); time.sleep(0.06)
e=find(lambda t:'Edge' in t and 'DevTools' not in t)[0]
u32.ShowWindow(e[0],3); u32.SetForegroundWindow(e[0]); time.sleep(0.9)
u32.keybd_event(VK_CTRL,0,0,0); tap(VK_L); u32.keybd_event(VK_CTRL,0,KEYUP,0); time.sleep(0.3)
type_text('chrome-extension://ehnnohlfcnokpmmmncebjajghkpakhpe/src/options/options.html')
time.sleep(0.3); tap(VK_RETURN); time.sleep(3.0)
ImageGrab.grab().save('test/final-options.png')
print('设置页截图完成')
