import ctypes, time, sys
from ctypes import wintypes
from PIL import ImageGrab

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    ctypes.windll.user32.SetProcessDPIAware()

u32 = ctypes.windll.user32
VK = {'ctrl':0x11,'l':0x4C,'return':0x0D}
KEYUP=0x0002; UNICODE=0x0004

def gtext(h):
    n=u32.GetWindowTextLengthW(h); b=ctypes.create_unicode_buffer(n+1)
    u32.GetWindowTextW(h,b,n+1); return b.value

def find_edge():
    out=[]
    Proc=ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(h,l):
        t=gtext(h)
        if t and 'Edge' in t and 'DevTools' not in t: out.append((h,t))
        return True
    u32.EnumWindows(Proc(cb),0); return out

def click(x,y):
    u32.SetCursorPos(int(x),int(y)); time.sleep(0.25)
    u32.mouse_event(0x0002,0,0,0,0)   # LEFTDOWN
    time.sleep(0.08)
    u32.mouse_event(0x0004,0,0,0,0)   # LEFTUP
    time.sleep(0.3)

ws=find_edge()
if not ws: print('无 Edge'); sys.exit(1)
hwnd,title=ws[0]
print('Edge:',title[:60])
u32.ShowWindow(hwnd,3); u32.SetForegroundWindow(hwnd); time.sleep(0.9)

sw, sh = u32.GetSystemMetrics(0), u32.GetSystemMetrics(1)
img = ImageGrab.grab()
print('系统尺寸:', sw, sh, '| 截图尺寸:', img.size)
sx = img.size[0]/sw if sw else 1

# 开发者模式开关：截图坐标 (386, 1991) 换算到系统坐标
cx, cy = int(386/sx), int(1991/sx)
print('点击坐标:', cx, cy)
click(cx, cy)
time.sleep(1.8)
ImageGrab.grab().save('test/shot-after-click.png')
print('已点击并截图')
