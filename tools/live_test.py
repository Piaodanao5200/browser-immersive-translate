import ctypes, time, sys
from ctypes import wintypes
from PIL import ImageGrab
try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception: ctypes.windll.user32.SetProcessDPIAware()
u32=ctypes.windll.user32
KEYUP=0x0002; UNICODE=0x0004
VK_CTRL,VK_L,VK_RETURN,VK_MENU,VK_T = 0x11,0x4C,0x0D,0x12,0x54

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
        u32.keybd_event(0,c,UNICODE,0); u32.keybd_event(0,c,UNICODE|KEYUP,0)
        time.sleep(0.012)
def tap(vk):
    u32.keybd_event(vk,0,0,0); u32.keybd_event(vk,0,KEYUP,0); time.sleep(0.05)
def combo(mod,vk):
    u32.keybd_event(mod,0,0,0); time.sleep(0.04)
    tap(vk)
    u32.keybd_event(mod,0,KEYUP,0); time.sleep(0.2)

e=[w for w in find(lambda t:'Edge' in t and 'DevTools' not in t)]
print('Edge 窗口:', e[0][1][:60] if e else '无')
if not e: sys.exit(1)
h=e[0][0]
u32.ShowWindow(h,3); u32.SetForegroundWindow(h); time.sleep(1.0)

combo(VK_CTRL, VK_L)
time.sleep(0.4)
type_text('http://127.0.0.1:8765/test/demo.html')
time.sleep(0.4)
tap(VK_RETURN)
print('已导航，等待加载...')
time.sleep(4.0)
ImageGrab.grab().save('test/live-before.png')

# Alt+T 触发翻译
u32.keybd_event(VK_MENU,0,0,0); time.sleep(0.05)
tap(VK_T)
u32.keybd_event(VK_MENU,0,KEYUP,0)
print('已按 Alt+T，等待翻译...')
time.sleep(6.0)
ImageGrab.grab().save('test/live-after.png')
print('截图完成')
