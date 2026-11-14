import ctypes, time, sys
from ctypes import wintypes
from PIL import ImageGrab
try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception: ctypes.windll.user32.SetProcessDPIAware()
u32 = ctypes.windll.user32

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
def click(x,y):
    u32.SetCursorPos(int(x),int(y)); time.sleep(0.25)
    u32.mouse_event(0x0002,0,0,0,0); time.sleep(0.09)
    u32.mouse_event(0x0004,0,0,0,0); time.sleep(0.4)

dlg=find(lambda t:'选择扩展目录' in t)
if not dlg: print('无对话框'); sys.exit(1)
h,t=dlg[0]; u32.SetForegroundWindow(h); time.sleep(0.5)
click(1822,1304)
time.sleep(2.8)
print('对话框已关闭:', not find(lambda t:'选择扩展目录' in t))
ImageGrab.grab().save('test/shot-installed.png')
print('截图完成')
