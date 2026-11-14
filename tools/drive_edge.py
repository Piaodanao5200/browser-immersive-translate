import ctypes, time, sys
from ctypes import wintypes
from PIL import ImageGrab

u32 = ctypes.windll.user32
EnumWindows = u32.EnumWindows
Proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
VK = {'ctrl':0x11,'l':0x4C,'return':0x0D,'f12':0x7B,'esc':0x1B}
KEYUP=0x0002; UNICODE=0x0004

def gtext(h):
    n=u32.GetWindowTextLengthW(h); b=ctypes.create_unicode_buffer(n+1)
    u32.GetWindowTextW(h,b,n+1); return b.value

def find():
    out=[]
    def cb(h,l):
        t=gtext(h)
        if t and 'Microsoft\u200b Edge' in t or (t and 'Edge' in t and 'DevTools' not in t):
            out.append((h,t))
        return True
    EnumWindows(Proc(cb),0); return out

def key(vk, up=False):
    u32.keybd_event(vk,0,KEYUP if up else 0,0); time.sleep(0.02)

def ctrl_key(vk):
    key(VK['ctrl']); key(vk); key(vk,True); key(VK['ctrl'],True); time.sleep(0.25)

def type_text(s):
    for ch in s:
        code=ord(ch)
        u32.keybd_event(0,code,UNICODE,0)
        u32.keybd_event(0,code,UNICODE|KEYUP,0)
        time.sleep(0.015)

ws = find()
if not ws: print('无窗口'); sys.exit(1)
hwnd,title = ws[0]
print('窗口:',title[:70])
u32.ShowWindow(hwnd, 3)          # SW_MAXIMIZE
u32.SetForegroundWindow(hwnd); time.sleep(0.8)
key(0x7B); key(0x7B,True)        # F12 关 DevTools
time.sleep(0.7)
ctrl_key(VK['l'])
type_text('edge://extensions')
time.sleep(0.3)
key(VK['return']); key(VK['return'],True)
time.sleep(3.0)
ImageGrab.grab().save('test/shot-edge-ext.png')
print('已导航并截图')
