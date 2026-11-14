import ctypes, time, sys
from ctypes import wintypes
from PIL import ImageGrab
try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception: ctypes.windll.user32.SetProcessDPIAware()
u32=ctypes.windll.user32
KEYUP=0x0002; VK_ESC=0x1B
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
for _ in range(4):
    d=find(lambda t:('选择扩展目录' in t) or ('扩展' in t and 'Edge' not in t and '选择' in t))
    if not d: break
    u32.SetForegroundWindow(d[0][0]); time.sleep(0.4)
    u32.keybd_event(VK_ESC,0,0,0); u32.keybd_event(VK_ESC,0,KEYUP,0)
    time.sleep(0.7)
print('剩余对话框:', [t for h,t in find(lambda t:'选择扩展目录' in t)])
e=find(lambda t:'Edge' in t and 'DevTools' not in t)[0]
u32.SetForegroundWindow(e[0]); time.sleep(0.8)
ImageGrab.grab().save('test/final-edge.png')
print('截图完成')
