import ctypes, time, sys
from ctypes import wintypes
from PIL import ImageGrab
try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception: ctypes.windll.user32.SetProcessDPIAware()
u32 = ctypes.windll.user32
KEYUP=0x0002; VK_RETURN=0x0D

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

dlg=find(lambda t:'选择扩展目录' in t)
if not dlg: print('对话框已关闭?'); 
else:
    h=dlg[0][0]
    u32.SetForegroundWindow(h); time.sleep(0.5)
    u32.keybd_event(VK_RETURN,0,0,0); u32.keybd_event(VK_RETURN,0,KEYUP,0)
    time.sleep(2.5)
    still=find(lambda t:'选择扩展目录' in t)
    print('对话框仍存在:' , bool(still))
ImageGrab.grab().save('test/shot-loaded.png')
print('截图完成')
