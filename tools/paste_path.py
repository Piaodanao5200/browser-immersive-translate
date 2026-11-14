import ctypes, time, sys
from ctypes import wintypes
from PIL import ImageGrab
try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception: ctypes.windll.user32.SetProcessDPIAware()
u32 = ctypes.windll.user32
KEYUP=0x0002
VK_CTRL,VK_A,VK_V,VK_RETURN = 0x11,0x41,0x56,0x0D

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

def combo(vk):
    u32.keybd_event(VK_CTRL,0,0,0); time.sleep(0.03)
    u32.keybd_event(vk,0,0,0); time.sleep(0.03)
    u32.keybd_event(vk,0,KEYUP,0); u32.keybd_event(VK_CTRL,0,KEYUP,0)
    time.sleep(0.3)

def click(x,y):
    u32.SetCursorPos(int(x),int(y)); time.sleep(0.2)
    u32.mouse_event(0x0002,0,0,0,0); time.sleep(0.08)
    u32.mouse_event(0x0004,0,0,0,0); time.sleep(0.3)

dlg=find(lambda t:'选择扩展目录' in t)
if not dlg: print('对话框不在'); sys.exit(1)
h,t=dlg[0]
u32.SetForegroundWindow(h); time.sleep(0.7)
combo(VK_A)
combo(VK_V)
time.sleep(0.6)
ImageGrab.grab().save('test/shot-pasted.png')
print('已粘贴，截图完成')
