import ctypes, time, sys
from ctypes import wintypes
from PIL import ImageGrab
try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception: ctypes.windll.user32.SetProcessDPIAware()
u32 = ctypes.windll.user32

def gtext(h):
    n=u32.GetWindowTextLengthW(h); b=ctypes.create_unicode_buffer(n+1)
    u32.GetWindowTextW(h,b,n+1); return b.value

def all_wins():
    out=[]
    P=ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(h,l):
        t=gtext(h)
        if t and u32.IsWindowVisible(h): out.append((h,t))
        return True
    u32.EnumWindows(P(cb),0); return out

def click(x,y):
    u32.SetCursorPos(int(x),int(y)); time.sleep(0.25)
    u32.mouse_event(0x0002,0,0,0,0); time.sleep(0.08)
    u32.mouse_event(0x0004,0,0,0,0); time.sleep(0.35)

edge=[w for w in all_wins() if 'Edge' in w[1] and 'DevTools' not in w[1]][0]
u32.ShowWindow(edge[0],3); u32.SetForegroundWindow(edge[0]); time.sleep(0.9)
before={w[0] for w in all_wins()}
print('点击 (1393,350)')
click(1393,350)
time.sleep(2.2)
after=all_wins()
new=[w for w in after if w[0] not in before]
print('新窗口:', [(h,t[:60]) for h,t in new] or '无')
ImageGrab.grab().save('test/shot-dlg2.png')
print('已截图')
